/**
 * The auto-rotation policy.
 *
 * This is a list of reasons the strip must hold still, and the reason it
 * exists as a tested function rather than a condition inside a timer is that
 * every entry on that list is a real way to annoy someone: a card that slides
 * away as they reach for it, motion a reader explicitly asked not to receive,
 * a background tab churning through slides no one can see.
 *
 * The tests below are written as "this one input, flipped, stops it" — so a
 * reason accidentally dropped from the predicate fails a test that names it,
 * rather than passing because some other input happened to be false.
 */

import { describe, it, expect } from 'vitest'
import { AUTOPLAY_INTERVAL_MS, autoplayActive, type AutoplayInputs } from '../src/client/autoplay.ts'

/** Every reason to run: a ring, measured, idle, motion allowed, tab visible. */
const RUNNING: AutoplayInputs = {
  ring: true,
  ready: true,
  engaged: false,
  reducedMotion: false,
  visible: true,
}

describe('autoplay policy', () => {
  it('runs when nothing is holding it', () => {
    expect(autoplayActive(RUNNING)).toBe(true)
  })

  // Each case sets exactly one input to the value that means STOP, so a
  // dropped clause names itself instead of hiding behind a neighbour.
  //
  // The stopping value is not the same for every input, and getting that
  // backwards is the easy mistake here: `engaged` and `reducedMotion` stop
  // when TRUE (the reason is present), while `ring`, `ready` and `visible`
  // stop when FALSE (the precondition is missing). Hence the explicit table
  // rather than one blanket flip.
  const stoppers: ReadonlyArray<readonly [keyof AutoplayInputs, boolean, string]> = [
    ['ring', false, 'fewer cards than fit: there is nowhere to advance to'],
    ['ready', false, 'the ring has not been measured yet'],
    ['engaged', true, 'the pointer or focus is on the strip'],
    ['reducedMotion', true, 'the reader asked for reduced motion'],
    ['visible', false, 'the tab is in the background'],
  ]

  for (const [key, stopValue, why] of stoppers) {
    it(`stops when ${key} is ${String(stopValue)} — ${why}`, () => {
      expect(autoplayActive({ ...RUNNING, [key]: stopValue })).toBe(false)
      // …and the same input left at its running value still runs, so the
      // case above is testing that key and not a neighbour.
      expect(autoplayActive({ ...RUNNING, [key]: !stopValue })).toBe(true)
    })
  }

  it('stops when several reasons hold at once', () => {
    expect(autoplayActive({ ...RUNNING, engaged: true, visible: false })).toBe(false)
  })

  it('advances fast enough to be noticed and slow enough to read', () => {
    // The feature was specified as 1.5s. Pinned as a range rather than an
    // equality so the floor and ceiling are what is actually being defended:
    // under ~1s a card cannot be read before it leaves, and over ~4s a reader
    // who does not touch the arrows may never see the fourth card at all.
    expect(AUTOPLAY_INTERVAL_MS).toBe(1500)
    expect(AUTOPLAY_INTERVAL_MS).toBeGreaterThanOrEqual(1000)
    expect(AUTOPLAY_INTERVAL_MS).toBeLessThanOrEqual(4000)
  })
})