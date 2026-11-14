/**
 * What a background revalidation may do to the store, and how often it runs.
 *
 * The two facts pinned here are the ones a poll gets wrong:
 *
 *   1. Only a refusal clears the credential. An IAM outage or a dropped call
 *      must leave the pair alone — otherwise a poll turns a network blip into a
 *      logout, and does it repeatedly.
 *   2. A hidden page or an empty store stops the loop rather than running it
 *      slower. Both cases are ones where no check can change anything.
 */

import { describe, expect, it, vi } from 'vitest'

import { nextCheckDelay, revalidate } from '../src/revalidate.ts'

/** A refusal, as `isRejection` sees it. */
class Refused extends Error {
  override readonly name = 'CredentialRejectedError'
}

/** The collaborators `revalidate` runs against, with the verifier under test's control. */
function deps(verify: () => Promise<string>) {
  const discard = vi.fn()
  return {
    deps: {
      verify,
      isRejection: (error: unknown): boolean => error instanceof Refused,
      discard,
    },
    discard,
  }
}

/** A stored pair; the values are irrelevant to this module. */
const stored = { ak: 'ak', sk: 'sk' }

describe('revalidate', () => {
  it('reports a accepted credential and does not touch the store', async () => {
    const { deps: collaborators, discard } = deps(async () => 'account-name')
    expect(await revalidate(stored, collaborators)).toEqual({
      kind: 'valid',
      accountName: 'account-name',
    })
    expect(discard).not.toHaveBeenCalled()
  })

  it('discards a credential IAM refused', async () => {
    const { deps: collaborators, discard } = deps(async () => { throw new Refused('refused') })
    expect(await revalidate(stored, collaborators)).toEqual({
      kind: 'refused',
      message: 'refused',
    })
    expect(discard).toHaveBeenCalledTimes(1)
  })

  it('leaves the store alone when the call never reached IAM', async () => {
    // The direction that matters. A poll that clears on any failure logs a
    // person out because their network blipped — and then does it again on the
    // next tick, now with nothing stored to explain why.
    const { deps: collaborators, discard } = deps(async () => { throw new Error('socket hang up') })
    expect(await revalidate(stored, collaborators)).toEqual({
      kind: 'unreachable',
      message: 'socket hang up',
    })
    expect(discard).not.toHaveBeenCalled()
  })

  it('classifies by the error, not by its message', async () => {
    // A message mentioning a status is not a refusal; only the type the host
    // classifies is. A message check would clear the store on wording.
    const { deps: collaborators, discard } = deps(async () => { throw new Error('HTTP 403') })
    expect((await revalidate(stored, collaborators)).kind).toBe('unreachable')
    expect(discard).not.toHaveBeenCalled()
  })
})

describe('nextCheckDelay', () => {
  const base = { hasCredential: true, visible: true, consecutiveUnreachable: 0, periodMs: 60_000 }

  it('stops when nothing is stored', () => {
    expect(nextCheckDelay({ ...base, hasCredential: false })).toBeUndefined()
  })

  it('stops while the page is hidden', () => {
    // Not a slower cadence: a hidden page's status is picked up on the next
    // visible tick, so running the loop here buys nothing and spends IAM quota.
    expect(nextCheckDelay({ ...base, visible: false })).toBeUndefined()
  })

  it('uses the ordinary period after a successful check', () => {
    expect(nextCheckDelay(base)).toBe(60_000)
  })

  it('backs off while IAM is unreachable', () => {
    expect(nextCheckDelay({ ...base, consecutiveUnreachable: 1 })).toBe(120_000)
    expect(nextCheckDelay({ ...base, consecutiveUnreachable: 2 })).toBe(240_000)
  })

  it('caps the backoff instead of doubling without a bound', () => {
    expect(nextCheckDelay({ ...base, consecutiveUnreachable: 10 })).toBe(300_000)
  })

  it('a hidden page outranks a pending backoff', () => {
    expect(nextCheckDelay({ ...base, visible: false, consecutiveUnreachable: 2 })).toBeUndefined()
  })
})