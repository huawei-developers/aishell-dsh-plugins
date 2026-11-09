/**
 * Running-mark shadow behavior.
 *
 * ui-chat's RunningWhaleTail renders the DeepSeek whale inside the
 * [data-chat-running] row — an APNG over a mask, plus a static SVG
 * fallback — all digest-protected, with no slot to occupy. What this file
 * pins is the CSS patch that stands in for it:
 *
 *   1. the patch hides both whale layers (the animated mask and the
 *      static fallback) and repaints the runningIcon box with the AI
 *      Shell mark as a background data URI;
 *   2. the mark's bob animation is guarded by
 *      prefers-reduced-motion: no-preference, so reduced motion shows
 *      the static mark — the same degradation the official whale gives;
 *   3. every selector is anchored on the row's stable literal attribute
 *      [data-chat-running] (the class names beside it are CSS-module
 *      hashes and matched by substring);
 *   4. install is idempotent (a second install reuses the same style
 *      element) and dispose removes it, restoring the official whale.
 *
 * The CSS is asserted as text: the selectors and the animation guard are
 * the contract, and the module is the only place the text exists.
 */

import { describe, it, expect } from 'vitest'
import { installRunningMarkShadow, RUNNING_MARK_PATCH_CSS, RUNNING_PATCH_MARKER } from '../src/client/running-mark-shadow.ts'
import { AISHELL_MARK_URI } from '../src/client/aishell-mark.ts'
import { makeStubDocument } from './stub-dom.ts'

describe('RUNNING_MARK_PATCH_CSS', () => {
  it('hides both whale layers inside the running row', () => {
    expect(RUNNING_MARK_PATCH_CSS).toContain('[data-chat-running] [class*="runningWhaleAnimated"]')
    expect(RUNNING_MARK_PATCH_CSS).toContain('[data-chat-running] [class*="runningWhaleStill"]')
    expect(RUNNING_MARK_PATCH_CSS).toContain('display: none;')
  })

  it('paints the runningIcon box with the AI Shell mark data URI', () => {
    expect(RUNNING_MARK_PATCH_CSS).toContain('[data-chat-running] [class*="runningIcon"]')
    expect(RUNNING_MARK_PATCH_CSS).toContain(`background: url("${AISHELL_MARK_URI}") center / contain no-repeat;`)
  })

  it('animates only under no-preference, matching the official whale degradation', () => {
    expect(RUNNING_MARK_PATCH_CSS).toContain('@media (prefers-reduced-motion: no-preference) {')
    expect(RUNNING_MARK_PATCH_CSS).not.toContain('@media (prefers-reduced-motion: reduce)')
    // The static mark stays visible under reduced motion because nothing
    // hides the runningIcon box itself.
    expect(RUNNING_MARK_PATCH_CSS).not.toMatch(/\[class\*="runningIcon"\][^}]*display:\s*none/)
  })
})

describe('installRunningMarkShadow', () => {
  it('injects the patch style into the head once and dispose removes it', () => {
    const document = makeStubDocument()
    const dispose = installRunningMarkShadow(document)
    const tag = document.head.querySelector(`style[${RUNNING_PATCH_MARKER}]`)
    expect(tag).not.toBeNull()
    expect(tag?.textContent).toBe(RUNNING_MARK_PATCH_CSS)
    dispose()
    expect(document.head.querySelector(`style[${RUNNING_PATCH_MARKER}]`)).toBeNull()
  })

  it('a second install reuses the element and the first dispose still removes it', () => {
    const document = makeStubDocument()
    const first = installRunningMarkShadow(document)
    const second = installRunningMarkShadow(document)
    const tags = document.head.querySelectorAll(`style[${RUNNING_PATCH_MARKER}]`)
    expect(tags).toHaveLength(1)
    first()
    second()
    expect(document.head.querySelectorAll(`style[${RUNNING_PATCH_MARKER}]`)).toHaveLength(0)
  })

  it('returns a no-op disposer when the target has no DOM surface', () => {
    const dispose = installRunningMarkShadow({} as Document)
    expect(() => { dispose() }).not.toThrow()
  })
})
