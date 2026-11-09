/**
 * Carousel position maths, kept pure so it can be tested without a DOM.
 *
 * The strip is a RING, not a scroll range: the cards form a circle, and an
 * arrow steps one card around it forever. Clicking next from the last
 * position lands on the first, and clicking prev from the first lands on the
 * last — and crucially, every intermediate position exists. A four-card ring
 * showing three at a time has FOUR positions, not two:
 *
 *      cards 1 2 3 4, three visible
 *      pos 0 → [1 2 3]
 *      pos 1 → [2 3 4]
 *      pos 2 → [3 4 1]     ← the wrap is visible, not a jump back
 *      pos 3 → [4 1 2]
 *      pos 4 → [1 2 3]     same as pos 0
 *
 * A plain scroll container cannot express that: its range is only
 * `content - viewport` (one step, for four cards), and positions 2 and 3 have
 * no place to live. So the card list is rendered {@link COPIES} times over
 * and the window travels through the middle copy, where both neighbours
 * always have content.
 *
 * ## Why the copies, and how the seam stays invisible
 *
 * With the list rendered three times, a window at physical position `p` shows
 * `cards[p .. p+VISIBLE-1]`, and position `2n` shows exactly what position `n`
 * shows. That equivalence is the seam: once a slide settles at `2n`, the
 * track can be placed at `n` in the same frame with transitions off, and
 * nothing on screen changes. The same holds at the other end, where `n-1` and
 * `2n-1` are the same window.
 *
 * The rewind happens only AFTER the slide finishes — never before. Jumping
 * first would put the destination on screen instantly and then animate away
 * from it, so a click at the seam would appear to skip a card. This is the
 * one law in this module that a reader is likely to get backwards.
 *
 * @module @huaweidevtools/aishell-dsh-brand/client/carousel
 */

/**
 * How many times the card list is rendered.
 *
 * Three is the minimum that works. The window lives in the middle copy, so it
 * needs one full copy behind it (to show the cards before the start) and one
 * ahead (to show the cards past the end while a slide is finishing at the
 * seam, where the position may briefly reach `2n` and read up to
 * `2n + VISIBLE - 1`).
 */
export const COPIES = 3

/** How many cards to render for a ring of `n`. */
export function ringLength(n: number): number {
  return n * COPIES
}

/**
 * The physical position the ring starts at — the first card of the middle
 * copy. Starting here rather than at 0 is what makes the very first prev
 * click land on a real card instead of an empty track.
 */
export function ringStart(n: number): number {
  return n
}

/**
 * Where a settled position should be silently rewound to, or `null` when it
 * is already inside the working band.
 *
 * The band is `[n, 2n-1]`. A slide may finish one past either end — `2n`
 * going forward, `n-1` going backward — and both have an exact twin inside
 * the band. See the module note for why this runs after the slide, not
 * before.
 */
export function rewindTo(pos: number, n: number): number | null {
  if (pos >= 2 * n) return n
  if (pos < n) return 2 * n - 1
  return null
}

/** One arrow press, resolved into the physical positions involved. */
export interface RingStep {
  /**
   * Where the track must be placed with transitions OFF before the slide.
   * Equal to the incoming position when no rewind is due; when it differs,
   * the jump is invisible (both positions show the same window).
   */
  readonly from: number
  /**
   * Where the slide ends. May sit one past the band's end, in which case the
   * next {@link rewindTo} brings it back.
   */
  readonly to: number
}

/**
 * Resolve one arrow press on a ring.
 *
 * Any rewind still owed from the previous press is settled first, so a person
 * clicking faster than the slide animation cannot walk the window off the
 * rendered copies — the band always absorbs one more step.
 */
export function ringStep(pos: number, delta: number, n: number): RingStep {
  const owed = rewindTo(pos, n)
  const from = owed ?? pos
  return { from, to: from + delta }
}

/**
 * One arrow press on a plain strip (fewer cards than fit): step by one and
 * stay inside the scrollable range.
 *
 * @param maxPos - the last meaningful position, `0` when nothing scrolls.
 */
export function clampStep(pos: number, delta: number, maxPos: number): number {
  if (maxPos <= 0) return 0
  return Math.max(0, Math.min(maxPos, pos + delta))
}