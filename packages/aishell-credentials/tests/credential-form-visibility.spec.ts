/**
 * The credential form's visibility state machine.
 *
 * One door: a chip opens the form, a save or a cancel closes it. The spec pins
 * the two properties that matter at that size — an open while already open must
 * not remount the component (it would discard what the person typed), and every
 * way out must withdraw the interaction, because a published-but-never-withdrawn
 * interaction leaves the form on screen and nothing throws.
 */

import { describe, it, expect, beforeEach } from 'vitest'

const { createCredentialFormVisibility } = await import('../src/client/credential-form-visibility.ts')

/** Interactions published so far, and how many were withdrawn. */
let published: Array<{ kind: string, key: string, sessionId: unknown }> = []
let withdrawn = 0
/** Conversations the machine asked to navigate to. */
let revealed: string[] = []
/** Keys the registry still reports as pending; everything else has gone stale. */
let stillPending = new Set<string>()

beforeEach(() => {
  published = []
  withdrawn = 0
  revealed = []
  stillPending = new Set()
})

/** Build a state machine over the recording publisher and navigator. */
function make() {
  return createCredentialFormVisibility({
    publish: (interaction) => {
      published.push(interaction as never)
      // The real registry reports a published interaction as pending until it
      // is withdrawn, so the stub does the same. A spec that wants a stale
      // record removes the key itself.
      stillPending.add(interaction.key)
      return () => {
        withdrawn += 1
        stillPending.delete(interaction.key)
      }
    },
    revealSession: (sessionId) => { revealed.push(sessionId) },
    isStillPending: (interaction) => stillPending.has(interaction.key),
  })
}

describe('credential form visibility', () => {
  it('publishes nothing until opened', () => {
    const visibility = make()
    expect(visibility.current()).toBeUndefined()
    expect(published).toHaveLength(0)
  })

  it('publishes one interaction for the opening session', () => {
    const visibility = make()
    visibility.open('session-1')

    expect(published).toHaveLength(1)
    expect(visibility.current()?.sessionId).toBe('session-1')
    expect(visibility.current()?.kind).toBe('aishell-credential-form')
  })

  it('does not republish within the conversation it is already open in', () => {
    // A second interaction would carry a new `key`, the framework remounts on a
    // key change, and the person's half-typed AK/SK is gone. That reasoning is
    // about ONE screen, so it applies to a repeat click in the same
    // conversation — see the next case for what a different one does.
    const visibility = make()
    visibility.open('session-1')
    const first = visibility.current()

    visibility.open('session-1')

    expect(published).toHaveLength(1)
    expect(visibility.current()).toBe(first)
  })

  it('navigates to the conversation that already has the form', () => {
    // The form renders inside ONE conversation and there is one credential
    // store behind it, so a second card in another conversation would be a
    // second live form over the same records. The person is taken to the card
    // they already have — the same navigation the sidebar performs.
    //
    // This is also what fixes the chip going dead: refusing used to leave the
    // remembered interaction in place after the card left the screen (switching
    // conversation or workspace), and every later click did nothing until a
    // reload.
    const visibility = make()
    visibility.open('session-1')
    const first = visibility.current()

    visibility.open('session-2')

    // Nothing new published, and the first interaction is still the one on
    // screen — just somewhere else.
    expect(published).toHaveLength(1)
    expect(visibility.current()).toBe(first)
    expect(revealed).toEqual(['session-1'])
  })

  it('does not navigate when the click is in the form\'s own conversation', () => {
    const visibility = make()
    visibility.open('session-1')

    visibility.open('session-1')

    expect(revealed).toEqual([])
    expect(published).toHaveLength(1)
  })

  it('opens fresh when the remembered interaction is no longer on screen', () => {
    // The machine remembers what it published, and only an explicit `close()`
    // clears that record. The card can leave the screen by paths that never
    // call one — a workspace switch, a re-render that unmounts the chain — and
    // then the record outlives it. Trusting it would navigate the person to a
    // conversation with no form on it, so the registry is asked instead.
    const visibility = make()
    visibility.open('session-1')
    const first = visibility.current()

    // The card is gone from the registry without a close: simulate the
    // framework having dropped it.
    stillPending.clear()

    visibility.open('session-2')

    // Not a navigation to the stale conversation, and not a refusal — a real
    // form in the conversation that asked.
    expect(revealed).toEqual([])
    expect(published).toHaveLength(2)
    expect(visibility.current()).not.toBe(first)
    expect(visibility.current()?.sessionId).toBe('session-2')
  })

  it('withdraws on close', () => {
    const visibility = make()
    visibility.open('session-1')
    visibility.close()

    expect(withdrawn).toBe(1)
    expect(visibility.current()).toBeUndefined()
  })

  it('treats a close with nothing open as a no-op', () => {
    const visibility = make()
    expect(() => { visibility.close() }).not.toThrow()
    expect(withdrawn).toBe(0)
  })

  it('withdraws on dispose, so a reload cannot leave the form on screen', () => {
    const visibility = make()
    visibility.open('session-1')
    visibility.dispose()

    expect(withdrawn).toBe(1)
    expect(visibility.current()).toBeUndefined()
  })

  it('reopens after a close, with a fresh key', () => {
    // A new key is what makes the reopened form mount empty rather than showing
    // the previous session's typed values.
    const visibility = make()
    visibility.open('session-1')
    const first = visibility.current()?.key
    visibility.close()
    visibility.open('session-1')

    expect(published).toHaveLength(2)
    expect(visibility.current()?.key).not.toBe(first)
  })

  it('gives each interaction a distinct key', () => {
    // The key is the framework's render identity; two forms sharing one would
    // look like the same presentation and not remount.
    const visibility = make()
    visibility.open('session-1')
    const first = visibility.current()?.key
    visibility.close()
    visibility.open('session-2')

    expect(visibility.current()?.key).not.toBe(first)
  })
})