/**
 * Auto-rotation policy for the example-prompt strip.
 *
 * Kept apart from the component and free of DOM, for the same reason
 * `carousel.ts` is: the DECISION is what needs pinning down, and a decision
 * buried in an effect can only be checked by watching a browser.
 *
 * ## Why the strip advances on its own
 *
 * The strip shows three of five cards, so cards are always off screen and a
 * reader who never touches the arrows never learns it exists. Rotation is what
 * makes the set self-evident. The cost is that content moves without being
 * asked to, which is why every reason to stop is collected here rather than
 * decided piecemeal at the call site.
 *
 * ## Every reason to stop
 *
 *  - `engaged` — the pointer is over the strip or focus is inside it. Someone
 *    reaching for a card must not have it slide out from under the cursor;
 *    this is the pause the feature was asked for, and `focus` is the half of
 *    it that covers a reader who never uses a pointer.
 *  - `reducedMotion` — the reader asked the platform for less movement. An
 *    element that moves by itself for more than five seconds is exactly what
 *    `prefers-reduced-motion` exists to suppress, and a hover pause cannot help
 *    the reader who cannot hover. Honouring it is what keeps the feature from
 *    being motion no one consented to.
 *  - `visible` — the tab is hidden. A background tab still fires timers, so
 *    without this the strip would churn through slides nobody can see and land
 *    somewhere arbitrary on return.
 *  - `ready` — the ring has not been measured yet. Advancing before the step
 *    is known would move the track by a wrong distance; see the measurement
 *    note in `SuggestionCards.tsx`.
 *  - `ring` — three cards or fewer all fit, so there is nowhere to advance to.
 *    A strip with nothing to scroll must not appear to scroll.
 *
 * @module @huaweidevtools/aishell-dsh-brand/client/autoplay
 */

/**
 * How long each card is shown before the strip advances.
 *
 * Fixed rather than configurable: this is a hint at what the product can do,
 * not a reading surface, and a setting nobody asked for is a setting nobody
 * finds.
 */
export const AUTOPLAY_INTERVAL_MS = 1500

/** Everything that can hold the strip still. */
export interface AutoplayInputs {
  /** More cards than fit, so there is somewhere to advance to. */
  readonly ring: boolean
  /** The ring has been measured and the track can be moved a known distance. */
  readonly ready: boolean
  /** The pointer is over the strip, or focus is inside it. */
  readonly engaged: boolean
  /** The reader asked for reduced motion. */
  readonly reducedMotion: boolean
  /** The tab is on screen. */
  readonly visible: boolean
}

/**
 * Whether the strip should be advancing on its own right now.
 *
 * Expressed as one predicate rather than a chain of early returns inside the
 * timer, so that adding a reason to stop is a change to this list and its
 * test — not a change to the effect that schedules the ticks.
 */
export function autoplayActive(inputs: AutoplayInputs): boolean {
  return inputs.ring
    && inputs.ready
    && !inputs.engaged
    && !inputs.reducedMotion
    && inputs.visible
}