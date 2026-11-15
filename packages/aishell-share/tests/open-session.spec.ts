/**
 * The order between pulling the session list and opening the imported session.
 *
 * The failure this pins is silent: `openSession` resolves ids against the
 * client's list snapshot, and a session the Host has just written is not in it.
 * `sessions.retain` throws `unknown session` — the import reports success, the
 * dialog closes, and nothing appears. So the ordering is the fix, and a test
 * that only checked "open was called" would pass on the broken version.
 */

import { describe, expect, it, vi } from 'vitest'

import { openSessionAfterRefresh } from '../src/client/open-session.ts'

describe('openSessionAfterRefresh', () => {
  it('pulls the list before navigating', async () => {
    // A shared log, because the claim is about order rather than occurrence:
    // both calls happening is not the same as them happening in this order.
    const steps: string[] = []
    await openSessionAfterRefresh('s-new', {
      refresh: async () => { steps.push('refresh') },
      open: (id) => { steps.push(`open:${id}`) },
    })
    expect(steps).toEqual(['refresh', 'open:s-new'])
  })

  it('waits for the pull to finish rather than starting both', async () => {
    // Launching the pull and navigating immediately would resolve the id
    // against the snapshot from before the pull — the original defect.
    const steps: string[] = []
    await openSessionAfterRefresh('s-new', {
      refresh: () => new Promise<void>((resolve) => {
        setTimeout(() => { steps.push('refresh'); resolve() }, 10)
      }),
      open: () => { steps.push('open') },
    })
    expect(steps).toEqual(['refresh', 'open'])
  })

  it('still navigates when the pull fails', async () => {
    // The session exists — the Host wrote it and answered with its id. A pull
    // that failed leaves the list stale, which is the transient part; declining
    // to open would turn that into an import that produced nothing visible.
    const open = vi.fn()
    await expect(openSessionAfterRefresh('s-new', {
      refresh: async () => { throw new Error('list unavailable') },
      open,
    })).resolves.toBeUndefined()
    expect(open).toHaveBeenCalledWith('s-new')
  })

  it('reports a navigation that threw instead of leaving an unhandled rejection', async () => {
    // `openSession` throws synchronously when the id is still unknown. Called
    // from a `.then` at the call site that becomes a rejected promise nobody
    // handles — the same silence the ordering exists to remove.
    const failed: Array<[unknown, string]> = []
    await expect(openSessionAfterRefresh('s-new', {
      refresh: async () => {},
      open: () => { throw new Error('sessions.retain: unknown session s-new') },
      onOpenFailed: (error, id) => { failed.push([error, id]) },
    })).resolves.toBeUndefined()
    expect(failed).toHaveLength(1)
    expect(String(failed[0]?.[0])).toMatch(/unknown session/)
    expect(failed[0]?.[1]).toBe('s-new')
  })

  it('survives a throwing navigation with no reporter attached', async () => {
    // The reporter is optional; without one the attempt still resolves rather
    // than rejecting into a caller that already returned.
    await expect(openSessionAfterRefresh('s-new', {
      refresh: async () => {},
      open: () => { throw new Error('boom') },
    })).resolves.toBeUndefined()
  })

  it('opens once per call, whether the pull settled or rejected', async () => {
    // Both paths reach navigation exactly once. A version that opened from a
    // settled pull and again from a rejected one would navigate twice, which
    // for the same id means the same reveal performed twice.
    const open = vi.fn()
    await openSessionAfterRefresh('s-new', { refresh: async () => {}, open })
    expect(open).toHaveBeenCalledTimes(1)

    await openSessionAfterRefresh('s-new', {
      refresh: async () => { throw new Error('list unavailable') },
      open,
    })
    expect(open).toHaveBeenCalledTimes(2)
    expect(open.mock.calls).toEqual([['s-new'], ['s-new']])
  })
})