/**
 * What `loadAccount` does when verification does not succeed.
 *
 * The distinction this file pins is between two failures that look alike from
 * the call site and call for opposite responses:
 *
 *   - **IAM rejected the credential.** The person's to fix. `undefined` is the
 *     right answer, and the caller's "not authenticated" wording is accurate.
 *   - **IAM was never reached** — a timeout, DNS, a proxy, a 5xx. Nobody's
 *     mistake, and telling the person to re-authenticate sends them to re-enter
 *     a credential that was already correct.
 *
 * Returning `undefined` for both collapses them, so a transient fault is
 * reported as a credential problem. These cases are what keep them apart, and
 * they are asserted through the module's own `status` marker rather than by
 * stubbing the verifier: the point is that the real classification reaches this
 * decision.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

/** The verdict the stubbed verifier answers with. */
let verdict: unknown = { ok: false, status: 401, message: 'rejected' }

vi.mock('@huaweidevtools/aishell-dsh-credentials-store/verify', () => ({
  verifyCredentials: () => Promise.resolve(verdict),
}))

const { configureCredentials, loadAccount, forgetAccount } = await import('../src/credentials.ts')
const { MemoryBackend } = await import('@huaweidevtools/aishell-dsh-credentials-store')
const { writeHuaweiCloud } = await import('@huaweidevtools/aishell-dsh-credentials-store/accounts')

/** A store holding one usable pair, bound as the plugin would bind it. */
function mount(): void {
  const store = new MemoryBackend()
  writeHuaweiCloud(store, { ak: 'AK', sk: 'SK' })
  configureCredentials({ store, region: 'cn-north-4' })
  forgetAccount()
}

beforeEach(() => {
  verdict = { ok: false, status: 401, message: 'rejected' }
})

describe('loadAccount — a rejected credential is the person\'s to fix', () => {
  it('answers undefined when IAM refused the credential', async () => {
    mount()
    verdict = { ok: false, status: 401, message: 'Huawei Cloud rejected the credentials (HTTP 401)' }

    await expect(loadAccount()).resolves.toBeUndefined()
  })

  it('answers undefined when IAM refused it outright with 403', async () => {
    mount()
    verdict = { ok: false, status: 403, message: 'forbidden' }

    await expect(loadAccount()).resolves.toBeUndefined()
  })
})

describe('loadAccount — a call that never landed is not a credential problem', () => {
  it('throws when IAM could not be reached', async () => {
    // `status: 0` is the verify module's marker for "never reached IAM".
    mount()
    verdict = { ok: false, status: 0, message: 'Could not reach Huawei Cloud IAM: ECONNREFUSED' }

    await expect(loadAccount()).rejects.toThrow(/ECONNREFUSED/)
  })

  it('says the credentials were not rejected, so the remedy is a retry', async () => {
    // The message is the whole remedy: a person told only "verification failed"
    // goes and re-creates a key that was never the problem.
    mount()
    verdict = { ok: false, status: 0, message: 'Could not reach Huawei Cloud IAM: timeout' }

    await expect(loadAccount()).rejects.toThrow(/not rejected — retry/)
  })

  it('throws when IAM failed rather than refused', async () => {
    // A 5xx is IAM breaking, not the credential being wrong.
    mount()
    verdict = { ok: false, status: 503, message: 'Service Unavailable' }

    await expect(loadAccount()).rejects.toThrow(/Service Unavailable/)
  })
})

describe('loadAccount — the ordinary cases are unchanged', () => {
  it('resolves the identity when the credential verifies', async () => {
    mount()
    verdict = {
      ok: true,
      account: { accountId: 'acct-1', name: 'the-account', projects: [] },
      region: 'cn-north-4',
      sts: false,
    }

    await expect(loadAccount()).resolves.toEqual({ account_id: 'acct-1', account_name: 'the-account' })
  })

  it('answers undefined when nothing is stored', async () => {
    // No credential is not a failure of a call; it is the absent case the
    // caller already words as "not authenticated".
    configureCredentials({ store: new MemoryBackend(), region: 'cn-north-4' })
    forgetAccount()

    await expect(loadAccount()).resolves.toBeUndefined()
  })
})
