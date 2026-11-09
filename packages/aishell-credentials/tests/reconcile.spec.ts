/**
 * Reconcile decision table and race guards.
 *
 * These pin the behavior that replaced the old one-shot boot check: the
 * status is re-derived from the store on demand, the `credentialsStored` flag
 * and the `accessKeyIdHint` are reconciled as independent facts, and a
 * verification in flight when the store is cleared (or rotated) must not
 * record a hint for credentials that are no longer there.
 *
 * Driven through `createCredentialReconciler` with a `MemoryBackend` and a
 * controllable verifier — never a real keyring or IAM call.
 */

import { describe, it, expect, vi } from 'vitest'
import { createCredentialReconciler } from '../src/reconcile.ts'
import { MemoryBackend } from '@huaweidevtools/aishell-dsh-credentials-store'
import {
  clearCredentials,
  readStoredPair,
  writeHuaweiCloud,
} from '@huaweidevtools/aishell-dsh-credentials-store/accounts'
import type { SettingsPathOp } from '@deepseek-ai/dsh-settings'

/** A controllable verifier: resolves each in-flight call on demand, in FIFO order. */
interface ControllableVerify {
  readonly fn: (ak: string, sk: string, token?: string) => Promise<string>
  /** Resolve the oldest pending call with `name`. */
  readonly resolve: (name: string) => void
  /** Reject the oldest pending call with the error. */
  readonly reject: (error: Error) => void
  /** How many times the verifier was called. */
  readonly calls: () => number
  /** How many calls are still awaiting a resolve/reject. */
  readonly pending: () => number
}

function controllableVerify(): ControllableVerify {
  let calls = 0
  let live = 0
  const queue: Array<(name: string) => void> = []
  const rejectQueue: Array<(error: Error) => void> = []
  const fn = vi.fn((_ak: string, _sk: string, _token?: string): Promise<string> => {
    calls += 1
    live += 1
    return new Promise<string>((resolve, reject) => {
      queue.push((name) => { live -= 1; resolve(name) })
      rejectQueue.push((error) => { live -= 1; reject(error) })
    })
  })
  return {
    fn,
    calls: () => calls,
    pending: () => live,
    resolve: (name: string): void => { queue.shift()?.(name); rejectQueue.shift() },
    reject: (error: Error): void => { rejectQueue.shift()?.(error); queue.shift() },
  }
}

/** The recorded mirror the reconciler reads and the routes-style harness writes. */
interface Mirror {
  stored: boolean
  hint: string | null
}

/** Reconciler harness bound to a fresh store, mirror, and recorded-ops log. */
interface Harness {
  readonly store: MemoryBackend
  readonly reconcile: () => void
  readonly resetVerifyBaseline: () => void
  readonly mirror: Mirror
  /** Every `recordStatus` call, in order. */
  readonly ops: SettingsPathOp[][]
  readonly verify: ControllableVerify
  /** How many times the reconciler discarded the stored pair. */
  readonly discards: () => number
}

function setup(): Harness {
  const store = new MemoryBackend()
  const mirror: Mirror = { stored: false, hint: null }
  const ops: SettingsPathOp[][] = []
  const verify = controllableVerify()
  let discards = 0
  const reconciler = createCredentialReconciler({
    verify: verify.fn,
    // The real predicate keys on a typed error; the harness keys on a marker
    // in the message so a test can express "this was a refusal" without
    // importing the plugin's private error class.
    isRejection: (error: unknown): boolean =>
      error instanceof Error && error.message.startsWith('REJECTED'),
    discard: () => {
      discards += 1
      clearCredentials(store)
    },
    recordStatus: (batch) => {
      ops.push([...batch])
      for (const op of batch) {
        if (op.path[0] === 'credentialsStored') {
          mirror.stored = op.op === 'set' && op.value === true
        } else if (op.path[0] === 'accessKeyIdHint') {
          const name = op.op === 'set' && typeof op.value === 'string' ? op.value : ''
          mirror.hint = name.length > 0 ? name : null
        }
      }
    },
    readStored: () => mirror.stored,
    readHint: () => mirror.hint,
    readPair: () => readStoredPair(store),
  })
  return {
    store,
    reconcile: reconciler.reconcile,
    resetVerifyBaseline: reconciler.resetVerifyBaseline,
    mirror,
    ops,
    verify,
    discards: () => discards,
  }
}

/** Plant AK/SK (and optional token) into the store. */
function plant(store: MemoryBackend, ak: string, sk: string, token?: string): void {
  writeHuaweiCloud(store, { ak, sk, ...(token === undefined ? {} : { securityToken: token }) })
}

/** Flatten recorded ops to a compact string for assertion messages. */
function flat(ops: SettingsPathOp[][]): string[] {
  return ops.flat().map(o => `${o.op}:${o.path.join('.')}`)
}

describe('reconcile — boot and transitions', () => {
  it('records credentialsStored and verifies once when credentials are present at boot', async () => {
    const h = setup()
    plant(h.store, 'AK', 'SK')
    h.reconcile()

    // stored flipped true; verify fired exactly once; hint not yet recorded.
    expect(h.mirror.stored).toBe(true)
    expect(h.verify.calls()).toBe(1)
    expect(h.mirror.hint).toBeNull()

    h.verify.resolve('hw026763134')
    await Promise.resolve()

    expect(h.mirror.hint).toBe('hw026763134')
    // No second verify for the same material on a later tick.
    h.reconcile()
    expect(h.verify.calls()).toBe(1)
  })

  it('records nothing when the store is empty at boot', () => {
    const h = setup()
    h.reconcile()
    expect(h.ops).toHaveLength(0)
    expect(h.verify.calls()).toBe(0)
  })

  it('picks up credentials written after boot on a later tick (regresses D1)', async () => {
    const h = setup()
    h.reconcile()
    expect(h.verify.calls()).toBe(0)

    // The env's sync-hw-creds writes the keyring after boot.
    plant(h.store, 'AK', 'SK')
    h.reconcile()

    expect(h.mirror.stored).toBe(true)
    expect(h.verify.calls()).toBe(1)
    h.verify.resolve('account')
    await Promise.resolve()
    expect(h.mirror.hint).toBe('account')
  })

  it('resets stored and hint when the store is emptied on a later tick', async () => {
    const h = setup()
    plant(h.store, 'AK', 'SK')
    h.reconcile()
    h.verify.resolve('account')
    await Promise.resolve()
    expect(h.mirror).toEqual({ stored: true, hint: 'account' })

    h.store.delete('aishell-credential')
    h.reconcile()

    expect(h.mirror).toEqual({ stored: false, hint: null })
    expect(flat(h.ops)).toContain('unset:accessKeyIdHint')
  })
})

describe('reconcile — fingerprint throttle and rotation', () => {
  it('does not retry the same material after a verify failure, but retries once it changes', async () => {
    const h = setup()
    plant(h.store, 'AK', 'SK')
    h.reconcile()
    expect(h.verify.calls()).toBe(1)
    h.verify.reject(new Error('401'))
    await Promise.resolve()

    // Same material on later ticks: no retry.
    h.reconcile()
    h.reconcile()
    expect(h.verify.calls()).toBe(1)
    expect(h.mirror.hint).toBeNull()

    // Material changes (rotation): retry once.
    writeHuaweiCloud(h.store, { ak: 'AK1', sk: 'SK2' })
    h.reconcile()
    expect(h.verify.calls()).toBe(2)
  })

  it('refreshes the account name when a stored credential is rotated (regresses the frozen-hint race)', async () => {
    const h = setup()
    plant(h.store, 'AK', 'SK')
    h.reconcile()
    h.verify.resolve('old-account')
    await Promise.resolve()
    expect(h.mirror.hint).toBe('old-account')

    // A rotation changes the material; the hint must update, not stay frozen.
    writeHuaweiCloud(h.store, { ak: 'AK1', sk: 'SK2' })
    h.reconcile()
    expect(h.verify.calls()).toBe(2)
    h.verify.resolve('new-account')
    await Promise.resolve()
    expect(h.mirror.hint).toBe('new-account')
  })
})

describe('reconcile — clear vs in-flight verify race', () => {
  it('does not record a hint for credentials that were cleared while a verify was in flight', async () => {
    const h = setup()
    plant(h.store, 'AK', 'SK')
    h.reconcile()
    expect(h.verify.calls()).toBe(1)

    // The clear route wipes the store and drops the verify baseline.
    h.store.delete('aishell-credential')
    h.resetVerifyBaseline()
    h.reconcile()
    expect(h.mirror).toEqual({ stored: false, hint: null })

    // The in-flight verify resolves late. Its .then re-checks the store: the
    // material is gone, so no hint is written.
    h.verify.resolve('ghost-account')
    await Promise.resolve()
    await Promise.resolve()
    expect(h.mirror.hint).toBeNull()
  })

  it('does not record a hint when the material was rotated mid-verify', async () => {
    const h = setup()
    plant(h.store, 'AK', 'SK')
    h.reconcile()

    // Rotate the secret while the first verify is still in flight.
    writeHuaweiCloud(h.store, { ak: 'AK1', sk: 'SK2' })
    h.reconcile() // fires a second verify against the new material

    // The first verify resolves with the old account name; its material no
    // longer matches the store, so it is discarded.
    h.verify.resolve('old-account')
    await Promise.resolve()
    expect(h.mirror.hint).toBeNull()

    // The second verify resolves with the new account name; its material still
    // matches, so it is recorded.
    h.verify.resolve('new-account')
    await Promise.resolve()
    expect(h.mirror.hint).toBe('new-account')
  })
})

/**
 * Let a rejected verification reach its `.catch`.
 *
 * `void verify(...).then(...).catch(...)` passes the rejection through two
 * microtask hops, so a single `await Promise.resolve()` only drains the first.
 * A macrotask drains the whole chain.
 */
async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0))
}

describe('reconcile — a credential IAM refused', () => {
  it('discards the stored pair and returns the status to "not configured"', async () => {
    // The state this prevents: an account name on screen beside a form asking
    // the person to sign in. A temporary credential whose token expired reaches
    // exactly that state if the pair is kept — the interface asserts two
    // opposite things at once.
    const h = setup()
    plant(h.store, 'AK-TEMP', 'SK', 'EXPIRED-TOKEN')
    h.reconcile()

    h.verify.reject(new Error('REJECTED: the security token has expired'))
    await settle()

    expect(h.discards()).toBe(1)
    expect(readStoredPair(h.store)).toBeUndefined()
    expect(h.mirror.stored).toBe(false)
    expect(h.mirror.hint).toBeNull()
  })

  it('re-arms verification so a fresh pair is checked immediately', async () => {
    // Discarding clears the fingerprint baseline. Without that, a new pair with
    // the same AK/SK (a renewed token differs, but a re-entered pair may not)
    // would be treated as unchanged material and never verified.
    const h = setup()
    plant(h.store, 'AK', 'SK')
    h.reconcile()
    h.verify.reject(new Error('REJECTED: refused'))
    await settle()
    expect(h.verify.calls()).toBe(1)

    plant(h.store, 'AK', 'SK')
    h.reconcile()
    expect(h.verify.calls()).toBe(2)
  })

  it('leaves the store untouched when the failure is not a refusal', async () => {
    // A network failure, a proxy, an IAM outage: the credential may be
    // perfectly good, and discarding it would sign the person out because their
    // network blipped.
    const h = setup()
    plant(h.store, 'AK', 'SK')
    h.reconcile()

    h.verify.reject(new Error('Could not reach Huawei Cloud IAM: ETIMEDOUT'))
    await settle()

    expect(h.discards()).toBe(0)
    expect(readStoredPair(h.store)).toEqual({ ak: 'AK', sk: 'SK' })
    expect(h.mirror.stored).toBe(true)
  })

  it('does not retry a refused pair on every tick', async () => {
    // The fingerprint guard still applies to a rejection: the pair is gone, so
    // there is nothing to retry, and a later reconcile is a no-op.
    const h = setup()
    plant(h.store, 'AK', 'SK')
    h.reconcile()
    h.verify.reject(new Error('REJECTED: refused'))
    await settle()

    h.reconcile()
    h.reconcile()
    expect(h.verify.calls()).toBe(1)
  })
})
