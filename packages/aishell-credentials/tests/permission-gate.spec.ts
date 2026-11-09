/**
 * Which flips need a risk confirmation.
 *
 * The decision is a pure function rather than a branch inside the hook so it can
 * be tested without a DOM renderer — this package carries none, and the chips'
 * specs are about styling, not state. That matters more than usual here: the
 * thing being pinned is *which direction escalates*, and getting it backwards
 * would put a warning on the harmless flip and none on the dangerous one.
 *
 * The hook itself is a thin adapter over {@link toggleOutcome} and
 * {@link mayApply}; see `permission-mode.ts`.
 */

import { describe, it, expect } from 'vitest'

const { toggleOutcome, mayApply } = await import('../src/client/permission-mode.ts')

describe('permission mode — which flips ask first', () => {
  it('asks before switching to read-write', () => {
    // Escalation: from here the agent may create, change and destroy real cloud
    // resources, and a destroyed resource usually does not come back.
    expect(toggleOutcome('read_only')).toBe('confirm')
  })

  it('applies a switch to read-only without asking', () => {
    // De-escalation gives up access. The consequence is "the agent can do less",
    // which needs no warning — and a dialog here would teach people to dismiss
    // the one that matters.
    expect(toggleOutcome('read_write')).toBe('apply')
  })

  it('does nothing while the mode is unknown', () => {
    // An unread mode is not read-only. Treating it as one would offer the
    // escalation dialog to a session that may already be in read-write, and
    // the confirm button would then write the mode that is already current.
    expect(toggleOutcome(undefined)).toBe('none')
  })
})

describe('permission mode — when the confirm button works', () => {
  it('stays dead until the acknowledgement is ticked', () => {
    expect(mayApply(false)).toBe(false)
  })

  it('applies once acknowledged', () => {
    expect(mayApply(true)).toBe(true)
  })
})