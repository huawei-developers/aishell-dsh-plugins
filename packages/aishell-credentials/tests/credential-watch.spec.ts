/**
 * The watch's timer behaviour: when it schedules, when it refuses to overlap,
 * and what a dispose does to a check already out.
 *
 * The decision of *whether* to check is `nextCheckDelay`'s and is pinned in
 * `revalidate.spec.ts`. What is pinned here is the loop around it — the part
 * that can spend IAM quota and then never stop.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { startCredentialWatch, WATCH_PERIOD_MS, type RevalidateState } from '../src/client/credential-watch.ts'

/** Timer control, so a spec drives the cadence instead of waiting for it. */
beforeEach(() => { vi.useFakeTimers() })
afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

/** Drive the watch with fixed collaborators; `revalidate` is the test's own. */
function watch(options: {
  hasCredential?: boolean
  visible?: boolean
  revalidate: (signal: AbortSignal) => Promise<RevalidateState | undefined>
}) {
  return startCredentialWatch({
    hasCredential: () => options.hasCredential ?? true,
    isVisible: () => options.visible ?? true,
    revalidate: options.revalidate,
  })
}

/** Advance past the ordinary period and let the check's promise settle. */
async function advanceOnePeriod(): Promise<void> {
  await vi.advanceTimersByTimeAsync(WATCH_PERIOD_MS)
}

describe('the credential watch', () => {
  it('checks once per period while the page is visible', async () => {
    const revalidate = vi.fn(async () => 'valid' as const)
    watch({ revalidate })

    await advanceOnePeriod()
    expect(revalidate).toHaveBeenCalledTimes(1)

    await advanceOnePeriod()
    expect(revalidate).toHaveBeenCalledTimes(2)
  })

  it('does not start while nothing is stored', async () => {
    const revalidate = vi.fn(async () => 'absent' as const)
    watch({ hasCredential: false, revalidate })

    await advanceOnePeriod()
    expect(revalidate).not.toHaveBeenCalled()
  })

  it('does not start while the page is hidden', async () => {
    const revalidate = vi.fn(async () => 'valid' as const)
    watch({ visible: false, revalidate })

    await advanceOnePeriod()
    expect(revalidate).not.toHaveBeenCalled()
  })

  it('stops on a dispose', async () => {
    const revalidate = vi.fn(async () => 'valid' as const)
    const handle = watch({ revalidate })

    handle.stop()
    await advanceOnePeriod()
    expect(revalidate).not.toHaveBeenCalled()
  })

  it('drops the check that was already out when it is disposed', async () => {
    // A check costs an IAM round trip and can outlive the fiber. Left running
    // it would reach the Host after the page stopped caring — at worst clearing
    // a store for a reload that has already replaced it.
    const seen: AbortSignal[] = []
    const revalidate = vi.fn(async (signal: AbortSignal) => {
      seen.push(signal)
      return await new Promise<RevalidateState>((resolve) => {
        // Resolves only if nobody aborts it, which is what the assertion below
        // distinguishes from an abort.
        signal.addEventListener('abort', () => { resolve('unreachable') }, { once: true })
      })
    })
    const handle = watch({ revalidate })

    const period = vi.advanceTimersByTime(WATCH_PERIOD_MS)
    expect(seen).toHaveLength(1)
    expect(seen[0]?.aborted).toBe(false)

    handle.stop()
    expect(seen[0]?.aborted).toBe(true)
    await period
  })

  it('does not stack checks when a period elapses mid-flight', async () => {
    // The failure this prevents: an IAM call slower than the period, plus a
    // save and a visibility change, all arming more checks over one credential.
    // Two concurrent checks double the quota spent for one answer.
    let release: (() => void) | undefined
    const revalidate = vi.fn(async () => {
      await new Promise<void>((resolve) => { release = resolve })
      return 'valid' as const
    })
    const handle = watch({ revalidate })

    await advanceOnePeriod()
    expect(revalidate).toHaveBeenCalledTimes(1)

    // Still in flight: a re-arm must not add a second call.
    handle.arm()
    handle.reset()
    await advanceOnePeriod()
    expect(revalidate).toHaveBeenCalledTimes(1)

    release?.()
    await Promise.resolve()
    // The next one is scheduled once the first returns.
    await advanceOnePeriod()
    expect(revalidate).toHaveBeenCalledTimes(2)
  })

  it('keeps the backoff across a visibility change but not across a new credential', async () => {
    const revalidate = vi.fn(async () => 'unreachable' as const)
    const handle = watch({ revalidate })

    // One unreachable answer earns a doubled delay.
    await advanceOnePeriod()
    expect(revalidate).toHaveBeenCalledTimes(1)

    // Still inside the doubled delay: arming must not pull it forward.
    handle.arm()
    await vi.advanceTimersByTimeAsync(WATCH_PERIOD_MS)
    expect(revalidate).toHaveBeenCalledTimes(1)

    // A new credential is a new question, so the backoff is forgotten.
    handle.reset()
    await advanceOnePeriod()
    expect(revalidate).toHaveBeenCalledTimes(2)
  })
})