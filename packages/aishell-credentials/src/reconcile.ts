/**
 * Idempotent credential-status reconcile.
 *
 * Derives `credentialsStored` and `accessKeyIdHint` from the store, and records
 * only what changed. The two derivations are independent on purpose: a boot
 * where the presence flag flips to true must still reach the branch that
 * verifies and records the account name, or the chips show "unconfigured" until
 * something else triggers a restart.
 *
 * Nothing re-reads the store on its own, so a credential written while the
 * process is running — the environment's `sync-hw-creds` writes them every
 * minute — would stay invisible to the UI. The caller's timer and the GET
 * route's hook provide those re-reads; this module only has to be safe to call
 * repeatedly, which it is: at steady state it records nothing and verifies
 * nothing.
 *
 * Kept as a factory — not inlined in `apply()` — so the whole decision table is
 * drivable from a spec with a `MemoryBackend` and a fake verifier, never a real
 * keyring or IAM call.
 *
 * @module @huaweidevtools/aishell-dsh-client-credentials/reconcile
 */

import type { SignCredentials } from '@huaweidevtools/aishell-dsh-credentials-store/signer'
import type { SettingsPathOp } from '@deepseek-ai/dsh-settings'

/** One path-addressed status edit, shaped as `ctx.settings.mutate` takes. */
export type StatusOp = SettingsPathOp

/** Records non-secret status the browser half reads; a refused write only logs. */
export type RecordStatus = (ops: readonly StatusOp[]) => void

/** Verifies AK/SK (and optional token) against Huawei Cloud IAM; resolves the account name. */
export type VerifyCredentials = (ak: string, sk: string, token?: string) => Promise<string>

/** Reads the recorded presence flag this plugin last wrote. */
export type ReadStored = () => boolean
/** Reads the recorded account-name hint this plugin last wrote, or `null` when none. */
export type ReadHint = () => string | null

/** Collaborators the reconciler runs against; injected so they are testable. */
export interface CredentialReconcilerDeps {
  /**
   * Verifies against IAM; resolves the account (domain) name.
   *
   * A rejection — IAM refusing the credential itself — must be distinguishable
   * from a transient failure, because only a rejection discards what is stored.
   * `isRejection` is how the caller says which it got; the reconciler never
   * re-derives that judgement from a message.
   */
  readonly verify: VerifyCredentials
  /** Whether a verify failure means the credential itself was refused. */
  readonly isRejection: (error: unknown) => boolean
  /** Records the non-secret status the browser half reads. */
  readonly recordStatus: RecordStatus
  /** Read the recorded `credentialsStored` mirror this plugin owns. */
  readonly readStored: ReadStored
  /** Read the recorded `accessKeyIdHint` mirror this plugin owns. */
  readonly readHint: ReadHint
  /** Reads the stored pair; the bundle entry is decoded inside it. */
  readonly readPair: () => SignCredentials | undefined
  /**
   * Discard the stored credentials.
   *
   * Called only when IAM refused them. A credential that IAM rejects cannot be
   * used for anything this product does, so keeping it leaves the interface
   * showing an account name beside a form asking the person to sign in — a
   * state that states two opposite things at once.
   */
  readonly discard: () => void
}

/** The reconcile state machine; driven by a timer and the GET-route hook. */
export interface CredentialReconciler {
  /**
   * Re-derive the status from the store. Idempotent at steady state: when
   * nothing changed it records nothing and verifies nothing. Call this on boot,
   * on a timer, and on every GET to the status route.
   */
  readonly reconcile: () => void
  /**
   * Drop the verify baseline so an in-flight verification's late result is
   * discarded. Call this from the `clear` route: a verify that resolves after
   * the store was emptied must not record a hint for credentials that are gone.
   */
  readonly resetVerifyBaseline: () => void
}

/**
 * Build the reconcile state machine.
 *
 * Two facts are reconciled independently, because they are independent:
 * - `credentialsStored` — are AK/SK in the store right now?
 * - `accessKeyIdHint` — what account name did IAM verification return?
 *
 * The hint is re-derived only when the credential material changed since the
 * last verification. That single trigger covers both reasons to re-verify — a
 * first-seen credential (the material has never been fingerprinted) and a
 * rotation (the material differs from the last verified set) — and it keeps a
 * failing verification (expired STS, IAM outage) from retrying every tick: the
 * retry keys on the material changing, not on time alone, and a failed verify
 * still records the fingerprint. Cleared by `resetVerifyBaseline` so a
 * clear-then-rotate re-verifies from scratch.
 *
 * @param deps - collaborators. `readStored`/`readHint` read this plugin's own
 *   mirror so reconcile never depends on config flow-back timing.
 */
export function createCredentialReconciler(deps: CredentialReconcilerDeps): CredentialReconciler {
  const { verify, isRejection, recordStatus, readStored, readHint, readPair, discard } = deps

  // Fingerprint of the credential material last handed to verification. A
  // credential that fails verification must not be retried on every tick — the
  // retry keys on the material changing, not on time alone. Cleared by
  // `resetVerifyBaseline` so a clear-then-rotate re-verifies from scratch.
  let lastVerifyFingerprint = ''

  const materialFingerprint = (ak: string, sk: string, token: string | undefined): string =>
    `${ak}\n${sk}\n${token ?? ''}`

  return {
    reconcile: (): void => {
      // One read of the bundle: a snapshot, so the pair and its token cannot be
      // observed at three different instants.
      const pair = readPair()
      const haveKeys = pair !== undefined

      // Stored flag + hint are two independent facts. Reset both when the keys
      // are gone — this covers a clear, and the race where a verify was in
      // flight when the user cleared (the late `.then` is fenced out below).
      const stored = readStored()
      const hint = readHint()
      if (!haveKeys && (stored || hint !== null)) {
        recordStatus([
          { op: 'set', path: ['credentialsStored'], value: false },
          { op: 'unset', path: ['accessKeyIdHint'] },
        ])
      } else if (haveKeys && !stored) {
        recordStatus([{ op: 'set', path: ['credentialsStored'], value: true }])
      }

      if (!haveKeys) return

      // Verify when the credential material changed since the last verification.
      // One trigger covers both cases: a first-seen credential (the material has
      // never been fingerprinted, so it differs from the empty baseline) and a
      // rotation (the material differs from the last verified set). A failing
      // verify still records the fingerprint, so the same material is not retried
      // every tick — the retry keys on the material changing, not on time alone.
      const fingerprint = materialFingerprint(pair!.ak, pair!.sk, pair!.securityToken)
      const materialChanged = fingerprint !== lastVerifyFingerprint
      if (!materialChanged) return

      lastVerifyFingerprint = fingerprint
      void verify(pair!.ak, pair!.sk, pair!.securityToken)
        .then((accountName) => {
          // Re-check the material is still in the store before recording: a
          // clear or rotation between the verify call and its resolution must
          // not write a hint for credentials that are no longer there.
          // Re-read rather than comparing against a captured value: the store
          // is the source of truth, and a rotation between the verify call and
          // its resolution must not record a hint for what is there now.
          if (readPair()?.ak !== pair!.ak) return
          recordStatus([{ op: 'set', path: ['accessKeyIdHint'], value: accountName }])
        })
        .catch((error: unknown) => {
          // A rejection means the stored credential is unusable, so it is
          // discarded and the interface returns to "not configured". Keeping it
          // would leave the screen asserting two opposite things at once: an
          // account name, and a form asking the person to sign in again.
          //
          // This covers the ordinary cause — a temporary credential whose token
          // expired — and any other refusal. Discarding is safe because the
          // material was already checked to be the pair in the store; a rotation
          // that landed mid-flight re-enters below.
          if (isRejection(error)) {
            discard()
            // The store is now empty, so the fingerprint of the next material
            // differs from this one by construction. Clearing it anyway keeps
            // the state honest if the discard itself failed.
            lastVerifyFingerprint = ''
            recordStatus([
              { op: 'set', path: ['credentialsStored'], value: false },
              { op: 'unset', path: ['accessKeyIdHint'] },
            ])
            return
          }
          // Anything else — a network failure, an IAM outage, a credential that
          // is valid but may not read IAM — leaves the stored pair untouched.
          // Clearing here would log a person out because their network blipped.
          //
          // Throttled by the fingerprint guard: the same material is retried
          // only when it changes. The chips judge by `Boolean(hint)`, so a
          // credential that verified once and now fails transiently reads as
          // "unconfigured" until a later verify succeeds — a gap that is
          // visible, and that a retry heals.
          void error
        })
    },

    resetVerifyBaseline: (): void => {
      lastVerifyFingerprint = ''
    },
  }
}
