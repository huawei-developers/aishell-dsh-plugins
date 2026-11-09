/**
 * Example-prompt cards for the New-Session hero.
 *
 * ## Where this renders, and why it takes a portal to get there
 *
 * The entry occupies `conversation.input.dock`, the band between the hero
 * workspace row and the input card. That is where the strip is MOUNTED — but
 * not where it is DRAWN: the product wants the cards directly under the hero
 * headline, and the workspace row sits between the two.
 *
 * Measured on the live page (1280×900):
 *
 *     hero (headline)              y=288  h=74
 *     hero workspace row           y=374  h=28
 *     conversation.input.dock      y=411  h=80
 *     the input card               y=491
 *
 * The row cannot be crossed with a margin — it would be covered — and its DOM
 * is a sibling subtree, unreachable from the dock. So the strip renders
 * through `createPortal` into the hero's own content div, the empty `_body`
 * the official shell leaves for exactly this. See `hero-content.ts` for how
 * that mount is found and why it fails closed.
 *
 * The dock entry is still what supplies the slot props (`useSession`,
 * `inputActions`, `t`), so the registration is unchanged; the portal only
 * relocates the output. What the dock band itself renders is nothing.
 *
 * ## When it renders
 *
 * The dock band renders in BOTH the hero and the docked composer (it only
 * needs a live input zone), so the gate is `session.blank` — the same
 * condition the account chip next door uses. `blank` is true from the moment a
 * New Session opens until the first turn is accepted: exactly the window the
 * cards exist for. Once the first message is sent the strip renders nothing
 * and the composer takes over.
 *
 * ## Why it does not look like the input card
 *
 * A card that wears a composer's materials reads as a second input box, and the
 * two materials that do it are identifiable rather than a matter of taste:
 *
 *   - **the composer's neutral.** `bg-module-platform` (`#353638` in dark) and
 *     `specific-input-major` (`#2c2c2e`) are rungs of one ramp, so a surface
 *     painted with either reads as a sibling of the other;
 *   - **the composer's shadow token.** `--dsw-elevation-soft` expands to
 *     `var(--dsw-elevation-stroke), …`, and that stroke is a `0 0 0 .5px` ring
 *     — so "no border" does not remove the outline, it only moves it into the
 *     shadow. A surface carrying this token has a hairline whether or not the
 *     CSS declares one.
 *
 * A card here is a CHOICE, so it wears the shell's vocabulary for a choice
 * rather than for a field. Every pickable surface in the product — the option
 * list in the question card (`border-radius: var(--dsw-radius-md)`,
 * `background: 0 0`), the command and trigger lists, the portalled menu — draws
 * itself the same way: a transparent ground, a `radius-md` corner, and a fill
 * that appears only on hover or selection. A field, by contrast, is an opaque
 * well inset into the page.
 *
 * So a card here is:
 *
 *   - TRANSLUCENT, not opaque and not empty. The shell explains this exact
 *     choice for `SegmentedControl`: a translucent fill "reads as a place
 *     rather than a second button". Opaque is what made the card a well;
 *     fully transparent is invisible on a white page, where the light theme
 *     would leave nothing but floating text. The tint is the shell's own
 *     interactive pair — `interactive-bg-hover` at rest, `interactive-bg-active`
 *     on hover — so hovering reads as the same material intensifying;
 *   - `radius-md` (12px), the choice radius, against the composer's 28px
 *     `radius-panel`;
 *   - no shadow at rest. The shell gives an elevated surface a shadow only
 *     when it FLOATS over other content (a menu, a hovercard, a modal); a
 *     card sitting inline in the page gets none, so neither does this.
 *
 * The icon tile keeps an accent tint — `Tag`'s info tone and the plan
 * package's chip both paint `color-mix(… business-primary 10%, transparent)`
 * — on a square with `radius-sm`, matching those chips' geometry.
 *
 * ## Auto-rotation
 *
 * The strip shows three of five cards, so two would otherwise be
 * invisible to anyone who does not touch the arrows. It advances one card
 * every {@link AUTOPLAY_INTERVAL_MS}, pausing on hover, on keyboard focus, in
 * a background tab, and under `prefers-reduced-motion`. The policy itself
 * lives in `autoplay.ts`, kept pure so the list of reasons to stop is testable
 * rather than buried in an effect.
 *
 * @module @huaweidevtools/aishell-dsh-brand/client/SuggestionCards
 */

import { type ReactNode, type TransitionEvent as ReactTransitionEvent, useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
// Type-only: pulls the Conversation slot contracts these props are typed
// against (the dock band, and the session standard kit it dispatches).
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { PropsRuntime, PropsLocale, TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
// Type-only: merges the `aishell-brand` key into LocaleNamespaceMap.
import type {} from './locales.ts'
import { SUGGESTIONS, type Suggestion } from './suggestions.ts'
import { SuggestionIconArt } from './suggestion-icons.tsx'
import { ringLength, ringStart, ringStep, rewindTo } from './carousel.ts'
import { AUTOPLAY_INTERVAL_MS, autoplayActive } from './autoplay.ts'
import { ensureHeroMount, findHeroContent, removeHeroMount } from './hero-content.ts'

/** How many cards a full-width strip shows at once. */
const VISIBLE = 3

/**
 * How much of a card's hue is washed into its own background, in percent.
 *
 * The card's ground is the shell's translucent interactive pair (neutral), and
 * this mixes the card's hue into BOTH ends of that pair so a card carries a
 * trace of its tile's colour without the hover turning into a colour change.
 *
 * 6 is measured rather than picked. Three things constrain it, and the numbers
 * below are computed from the real tokens in both themes:
 *
 *   - LEGIBILITY. The gloss text is the binding constraint, not the title. On
 *     the light theme's ground the gloss measures 3.33 at 0%, 3.14 at 8%, and
 *     falls to 2.90 at 14% — under the 3:1 bar. So the ceiling is ~12%.
 *   - VISIBILITY. A tint is not worth its cost below the just-noticeable
 *     difference (~2.3 dE). The card moves 3.4–5.1 dE away from its own
 *     untinted self at 6%, and only 1.7 dE at 3%, so the floor is ~4%.
 *   - THE TILE'S SEPARATION. The tile sits ON this ground, so tinting the
 *     ground eats the tile's contrast. Amber is the tightest case: 2.51 at 0%,
 *     2.39 at 6%, 2.31 at 10%. It survives, but this is why the percentage
 *     cannot be pushed for looks.
 *
 * 6% is the low end of the safe band, chosen deliberately: the tint is there to
 * warm the card toward its subject, not to become a colour block. It is not a
 * way to tell the cards apart — at 6% two different cards are only 2.4 dE
 * apart, barely at the threshold. The tile is what identifies a card.
 */
const HUE_WASH = 6

/** Full component props: the dock band's owner share + the session kit + `t`. */
export type SuggestionCardsProps =
  & PropsRuntime<'conversation.input.dock'>
  & PropsLocale<'aishell-brand'>

/** The bound translate function for this plugin's namespace. */
type Translate = TranslateNS<'aishell-brand'>

/**
 * The hero's content element, kept current across the hero's lifecycle.
 *
 * The hero mounts, unmounts and is REPLACED on each New Session, so the node
 * found at first paint goes stale. A `MutationObserver` is the only thing that
 * sees a replacement: the observer re-scans, and the scan is cheap because it
 * returns immediately while the current mount is still connected.
 *
 * @param active - whether the strip should be mounted at all.
 * @returns the element to portal into, or `null` while the hero is absent.
 */
function useHeroMount(active: boolean): HTMLElement | null {
  const [mount, setMount] = useState<HTMLElement | null>(null)
  const mountRef = useRef<HTMLElement | null>(null)

  useEffect(() => {
    // Deactivating does NOT clear the ref. The mount is still in the hero and
    // is reused when the strip comes back (the next New Session); clearing it
    // here would strand that node with nothing holding a handle to it, so the
    // unmount disposer below could never remove it. The scan clears the ref
    // only when the node it names has actually left the document.
    if (!active) {
      setMount(null)
      return
    }
    let cancelled = false
    const scan = (): void => {
      if (cancelled) return
      const current = mountRef.current
      // Still connected: nothing to do beyond handing the node back to state.
      //
      // That hand-back is load-bearing. Deactivating above clears `mount` so
      // the strip disappears, while the ref deliberately keeps the node — and
      // on a host that REUSES the hero (the preview does, and a base that
      // keeps the shell mounted would too) the node is still connected when
      // the session goes blank again. Without this the early return leaves
      // `mount` null forever and the strip never comes back. The functional
      // update bails out when state already names this node, so the common
      // case — a mutation anywhere on the page — costs no render.
      if (current !== null && current.isConnected) {
        setMount(seen => (seen === current ? seen : current))
        return
      }
      const content = findHeroContent(document)
      if (content === null) {
        mountRef.current = null
        setMount(null)
        return
      }
      const next = ensureHeroMount(content)
      if (next !== mountRef.current) {
        mountRef.current = next
        setMount(next)
      }
    }
    scan()
    const observer = new MutationObserver(scan)
    // childList only: the carousel animates `transform`, which is a style
    // change and must not re-enter the scan on every frame.
    observer.observe(document.body, { childList: true, subtree: true })
    return () => {
      cancelled = true
      observer.disconnect()
    }
  }, [active])

  // Removal runs on UNMOUNT only, and reads the ref rather than the returned
  // `mount`: the portal's children are React's to tear down, and a hero that
  // swapped its content div has already taken the node away, so this checks
  // the node is still parented before asking its parent to drop it.
  useEffect(() => () => {
    const current = mountRef.current
    mountRef.current = null
    if (current === null) return
    // Goes through `removeHeroMount` rather than `current.remove()` so the
    // spec covers the path the component actually takes: the helper only
    // removes a node carrying its own marker, so a mount some other owner
    // put there is never torn out from under it.
    removeHeroMount(current.parentElement ?? current)
  }, [])

  return mount
}

/** Whether the reader has asked the platform for reduced motion. */
function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(false)
  useEffect(() => {
    const query = window.matchMedia('(prefers-reduced-motion: reduce)')
    setReduced(query.matches)
    const onChange = (event: MediaQueryListEvent): void => { setReduced(event.matches) }
    query.addEventListener('change', onChange)
    return () => { query.removeEventListener('change', onChange) }
  }, [])
  return reduced
}

/** Whether the tab is on screen. A hidden tab must not churn through slides. */
function useTabVisible(): boolean {
  const [visible, setVisible] = useState(true)
  useEffect(() => {
    const onVisibility = (): void => { setVisible(document.visibilityState === 'visible') }
    onVisibility()
    document.addEventListener('visibilitychange', onVisibility)
    return () => { document.removeEventListener('visibilitychange', onVisibility) }
  }, [])
  return visible
}

/**
 * One card.
 *
 * A button, so keyboard activation, focus handling and disabled semantics come
 * for free. The icon is a decorative tile marked `aria-hidden`; the title and
 * gloss carry the meaning.
 */
function Card({ suggestion, onPick, t }: {
  readonly suggestion: Suggestion
  readonly onPick: (prompt: string) => void
  readonly t: Translate
}): ReactNode {
  const [hover, setHover] = useState(false)
  const [focus, setFocus] = useState(false)
  const lit = hover || focus
  return (
    <button
      type="button"
      onClick={() => { onPick(t(suggestion.promptKey)) }}
      onPointerEnter={() => { setHover(true) }}
      onPointerLeave={() => { setHover(false) }}
      onFocus={() => { setFocus(true) }}
      onBlur={() => { setFocus(false) }}
      // The basis is `cqw` — a percentage of the viewport container (see the
      // `containerType` note on it), which is what lets the three visible cards
      // divide the visible width evenly even though the track they sit in is
      // many times wider. A plain `%` would resolve against the track.
      //
      // `flex-shrink: 0` is load-bearing on a ring: the track is far wider
      // than the viewport, and a shrinkable card would be squeezed to nothing.
      style={{
        flex: `0 0 calc((100cqw - ${(VISIBLE - 1)} * var(--dsh-suggestion-gap)) / ${VISIBLE})`,
        display: 'flex',
        alignItems: 'flex-start',
        gap: 12,
        boxSizing: 'border-box',
        minWidth: 0,
        // Square-ish padding, from the shell's own choice surfaces (`8px 12px`
        // in the question card, `6px 8px` in the trigger list) scaled up for a
        // card that carries two lines of text and a 32px tile. 14px vertically
        // gives the tile the same optical margin it has horizontally, which is
        // what stops the solid block reading as wedged against the top edge.
        padding: '14px',
        textAlign: 'left',
        font: 'inherit',
        cursor: 'pointer',
        color: 'var(--dsw-alias-label-primary)',
        // The shell's own recipe for a pickable surface — see the module note for
        // the two composer materials that would make this card read as a
        // second input box, and which of them this avoids.
        //
        // A TRANSLUCENT fill, not an opaque one, and not "no fill" either. The
        // shell states the reasoning for this exact choice in
        // `SegmentedControl.module.css`: its track takes "the same translucent
        // fill the hover state uses, so it reads as a place rather than a
        // second button". Two properties follow, and both are load-bearing
        // here. A translucent fill can never be mistaken for a well — the
        // composer card is opaque in both themes — and unlike a fully
        // transparent ground it stays visible on a white page, where a
        // see-through card would simply disappear.
        //
        // Rest and hover are the shell's own adjacent pair for an interactive
        // surface, so the hover reads as the same material getting stronger
        // rather than as a second colour arriving.
        //
        // A wash of the card's own hue is mixed INTO that pair rather than
        // replacing it, which is the whole trick: the tint has to ride on top
        // of the neutral so the hover still reads as "same surface, more
        // present". Setting the tile colour directly for rest and the accent
        // for hover would have thrown that away and made the hover a colour
        // change. Mixed this way, both the rest and the hover carry the hue, so
        // hovering intensifies exactly what was already there.
        //
        // The percentage is measured, not chosen. See {@link HUE_WASH} for the
        // numbers: 6% is the largest value that keeps the light theme's gloss
        // text above 3:1, and it is also where the tint crosses the ~2.3
        // just-noticeable-difference line, so it is actually visible as colour
        // rather than costing legibility for nothing.
        background: lit
          ? `color-mix(in srgb, ${suggestion.hue.tile} ${HUE_WASH}%, var(--dsw-alias-interactive-bg-active))`
          : `color-mix(in srgb, ${suggestion.hue.tile} ${HUE_WASH}%, var(--dsw-alias-interactive-bg-hover))`,
        border: 'none',
        // `radius-md` is the choice radius (the question card's option list,
        // the trigger rows); the composer's is the 28px `radius-panel`.
        borderRadius: 'var(--dsw-radius-md, 12px)',
        // The timing is the shell's own for a choice surface (`.12s` on
        // `background-color`), so the strip's feel matches the lists it
        // borrows its recipe from.
        transition: 'background-color 120ms ease',
        // An outline, not a border swap: a border appearing on focus reflows
        // the card by a pixel and the row twitches under the ring.
        outline: focus ? '2px solid var(--dsw-alias-state-business-primary)' : 'none',
        outlineOffset: 2,
      }}
    >
      <span
        aria-hidden
        style={{
          flex: 'none',
          display: 'grid',
          placeItems: 'center',
          // 32 rather than 28: the tile is now a solid block of colour rather
          // than a whisper of tint, and at 28 a solid square this saturated
          // starts to look like a bullet rather than an icon holder. The extra
          // 4px also gives the 17px glyph the padding it needs to breathe.
          width: 32,
          height: 32,
          marginTop: 1,
          // `radius-sm` is what the shell's own chips wear at this height (the
          // plan chip is a 28px `radius-sm` box). Keeping the same radius as
          // the tile grows keeps it in the product's geometry rather than
          // making it rounder and softer than everything around it.
          borderRadius: 'var(--dsw-radius-sm, 8px)',
          // SOLID, not a tint, and the glyph sits on it in the theme's
          // on-colour. See `SuggestionHue` for why the tinted version was
          // measured and rejected: a hue on a tint of itself has 1.8–2.8
          // contrast, and a solid ground measures 5.4–9.9 for the same hues.
          background: suggestion.hue.tile,
          // The glyph goes in a FIXED ink, not a themed one, and that distinction is
          // load-bearing. The tile is a `--dsw-static-*` hue: identical in both
          // themes. The obvious token for "text on a filled control" is
          // `--dsw-alias-label-primary-foreground` — but that one FLIPS with the
          // theme (white in light mode, near-black in dark), so pairing it with
          // a static tile means the light theme draws a white glyph on a light
          // blue tile: measured 2.54 contrast, which is effectively invisible.
          //
          // `--dsw-static-neutral-bluish-1000` is `#0f1115` in BOTH themes, so
          // the pairing is stable. It also happens to be the better of the two
          // options on every one of these hues — measured on the five tiles,
          // ink gives 5.42–8.29 where white gives 2.28–3.49. These hues are all
          // light enough that dark-on-light is simply correct; the familiar
          // "saturated tile, white glyph" instinct is wrong for this palette.
          color: 'var(--dsw-static-neutral-bluish-1000, #0f1115)',
        }}
      >
        <SuggestionIconArt icon={suggestion.icon} size={17} />
      </span>
      <span style={{ display: 'flex', flexDirection: 'column', gap: 3, minWidth: 0 }}>
        <span style={{
          fontSize: 'var(--dsh-content-font-size-secondary, 13px)',
          fontWeight: 600,
          lineHeight: '19px',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        }}>
          {t(suggestion.titleKey)}
        </span>
        <span style={{
          fontSize: '12px',
          lineHeight: '17px',
          color: 'var(--dsw-alias-label-tertiary)',
          // Two lines then ellipsis: the gloss is a hint, and a card that
          // grows to fit a long one makes the whole row uneven.
          display: '-webkit-box',
          WebkitLineClamp: 2,
          WebkitBoxOrient: 'vertical',
          overflow: 'hidden',
        }}>
          {t(suggestion.glossKey)}
        </span>
      </span>
    </button>
  )
}

/** One carousel arrow. */
function Arrow({ direction, label, onClick }: {
  readonly direction: 'prev' | 'next'
  readonly label: string
  readonly onClick: () => void
}): ReactNode {
  const [hover, setHover] = useState(false)
  return (
    <button
      type="button"
      aria-label={label}
      onClick={onClick}
      onPointerEnter={() => { setHover(true) }}
      onPointerLeave={() => { setHover(false) }}
      style={{
        flex: 'none',
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        width: 26,
        height: 26,
        padding: 0,
        cursor: 'pointer',
        color: 'var(--dsw-alias-label-secondary)',
        background: hover ? 'var(--dsw-alias-interactive-bg-hover)' : 'transparent',
        border: 'none',
        borderRadius: 999,
        transition: 'background 120ms ease',
      }}
    >
      <svg aria-hidden width="14" height="14" viewBox="0 0 24 24">
        <path
          d={direction === 'prev' ? 'M15 5l-7 7 7 7' : 'M9 5l7 7-7 7'}
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    </button>
  )
}

export function SuggestionCards(props: SuggestionCardsProps): ReactNode {
  // Every hook runs before the early returns below: `blank` flips when the
  // first turn is accepted, and a render that skipped hooks React already
  // counted (error #300) would crash the whole dock band.
  const blank = props.useSession(session => session.blank)
  const setDraft = props.inputActions.setDraft
  // The framework-injected translate seat, present because the registration
  // declares `locale`. It reads the active locale at call time, so a language
  // switch re-renders every card without this component knowing about it.
  const t = props.t

  const n = SUGGESTIONS.length
  const ring = n > VISIBLE

  const viewportRef = useRef<HTMLDivElement | null>(null)
  const trackRef = useRef<HTMLDivElement | null>(null)
  // The ring position, 1-based over the rendered copies: position `n` is the
  // first card of the middle copy (see `ringStart`). A ref, not state: the
  // value changes on every arrow press and during the settle, and re-rendering
  // the strip for it would restart the CSS transition mid-flight.
  const posRef = useRef(ringStart(n))
  // One card's advance in px, measured from the DOM (card width + gap).
  const stepRef = useRef(0)
  // Whether the ring has been measured; the arrows wait for it so they never
  // appear over a strip that cannot move.
  const [ready, setReady] = useState(!ring)
  // The pointer is over the strip, or focus is inside it.
  const [engaged, setEngaged] = useState(false)

  const reducedMotion = useReducedMotion()
  const visible = useTabVisible()
  const mount = useHeroMount(blank)

  /**
   * The slide's own animation, written by this component and nobody else.
   *
   * `transform` and `transition` are BOTH owned by the imperative code below
   * and are deliberately absent from the `style` prop further down. They have
   * to have exactly one owner: a value declared in JSX is only re-applied when
   * React sees it CHANGE, so the first time the effect writes
   * `track.style.transition = 'none'` (or clears it with `''`), React's
   * declared value is gone and React has no reason to write it again. The
   * track then keeps the browser default — `all 0s` — and every "slide" lands
   * instantly with a hard cut. That is a silent failure: positions, wrapping
   * and the ring all still measure correct, so only watching the motion
   * reveals it.
   *
   * A slow, eased curve rather than a short linear one: the strip shows one
   * card leaving and one arriving, and at 320ms with a snappy curve it reads
   * as a jump cut rather than travel.
   *
   * The curve is `cubic-bezier(.33,0,.15,1)`, chosen for its END VELOCITIES
   * and not its looks on a graph. Measured as distance-per-unit-time (1.0
   * being a linear slide) it starts at 0.4, peaks near 2.7, and finishes at
   * 0.05 — eased away from rest and brought gently to rest. The obvious
   * "smooth" pick, `cubic-bezier(.16,.84,.28,1)` (a material-style fast-out),
   * starts at 4.39: it covers 44% of the distance in the first 10% of the
   * time and then crawls. On a row of cards that reads as a snap followed by
   * a stall, which is the opposite of what a carousel wants.
   */
  const SLIDE_MS = 520
  const SLIDE_EASING = 'cubic-bezier(.33,0,.15,1)'

  /** Place the track at a position with no transition. */
  const snapTo = useCallback((pos: number): void => {
    const track = trackRef.current
    if (track === null) return
    track.style.transition = 'none'
    track.style.transform = `translate3d(${-pos * stepRef.current}px, 0, 0)`
  }, [])

  /** Animate the track to a position. */
  const slideTo = useCallback((pos: number): void => {
    const track = trackRef.current
    if (track === null) return
    // Re-stated rather than cleared: `''` removes the inline property
    // entirely, which is how the transition went missing in the first place.
    track.style.transition = `transform ${SLIDE_MS}ms ${SLIDE_EASING}`
    track.style.transform = `translate3d(${-pos * stepRef.current}px, 0, 0)`
  }, [])

  // The pending auto-rotation tick, so any step can push it back.
  const autoplayTimerRef = useRef(0)
  // Holds the current `step`. `step` depends on this scheduler and the
  // scheduler has to call `step`, so one of the two has to go through a ref;
  // the ref is the scheduler's, and `step` publishes itself into it in an
  // effect rather than during render.
  const latestStepRef = useRef<(delta: number) => void>(() => {})
  /**
   * Schedule the next auto-rotation tick one full interval from now,
   * replacing any tick already pending.
   *
   * Called by every `step`, which is what makes the cadence immune to a tick
   * landing mid-slide.
   */
  const bumpAutoplay = useCallback((): void => {
    window.clearTimeout(autoplayTimerRef.current)
    autoplayTimerRef.current = window.setTimeout(() => { latestStepRef.current(1) }, AUTOPLAY_INTERVAL_MS)
  }, [])

  /**
   * Re-measure one step and re-apply the current position.
   *
   * The step is read from a real card rather than computed from the viewport
   * width so the `cqw` fraction in `Card`'s flex-basis and this number cannot
   * drift apart.
   *
   * Re-measuring is not optional. The first frame measures BEFORE the cards
   * have their final width: `containerType` and the `cqw` basis settle in a
   * later layout pass, so the first reading is a few percent too large (242px
   * where the settled card is 213px). A step kept from that frame puts every
   * position slightly too far along, which compounds — by the fourth card the
   * window has drifted a whole card and shows two cards plus a gap.
   */
  const remeasure = useCallback((): boolean => {
    const track = trackRef.current
    if (track === null) return false
    const first = track.firstElementChild as HTMLElement | null
    if (first === null) return false
    const gap = Number.parseFloat(getComputedStyle(track).columnGap) || 0
    const step = first.getBoundingClientRect().width + gap
    if (!(step > 0)) return false
    const changed = step !== stepRef.current
    stepRef.current = step
    if (changed) {
      // Re-apply the position under the new step without animating: the
      // window must show the same cards, and a transition here would make
      // every resize slide the strip sideways on its own. `snapTo` writes
      // `transition: none` itself, so nothing has to be turned off around it.
      snapTo(posRef.current)
    }
    return true
  }, [snapTo])

  // Measure on mount and whenever the strip comes back (a New Session), then
  // park the ring at its start. The observer keeps the step honest across
  // window resizes and width changes in the surrounding composer — without
  // it the ring keeps the step from whenever it was first laid out, and every
  // position lands progressively further from where it should.
  //
  // Depends on `mount`: the strip only exists once the portal target has been
  // found, so measuring before that would read a null track every time.
  useEffect(() => {
    if (!blank || !ring || mount === null) return
    let cancelled = false
    const settle = (): void => {
      if (cancelled) return
      if (!remeasure()) {
        // Layout has not happened yet; try again next frame.
        frame = window.requestAnimationFrame(settle)
        return
      }
      posRef.current = ringStart(n)
      snapTo(posRef.current)
      // The un-animated placement has to be applied before the strip is
      // usable, or the first slide would animate from the wrong origin.
      // `snapTo` leaves `transition: none` behind, so the first `slideTo`
      // restores the curve — nothing else has to re-arm it here.
      window.requestAnimationFrame(() => {
        if (cancelled) return
        setReady(true)
        // Only now is there a real card to observe.
        const viewport = viewportRef.current
        if (viewport !== null) {
          observer = new ResizeObserver(() => { remeasure() })
          observer.observe(viewport)
        }
      })
    }
    let frame = window.requestAnimationFrame(settle)
    let observer: ResizeObserver | undefined
    return () => {
      cancelled = true
      window.cancelAnimationFrame(frame)
      observer?.disconnect()
    }
  }, [blank, ring, n, mount, remeasure, snapTo])

  /**
   * Apply whichever rewind the settling position owes.
   *
   * Runs when the track reaches its destination, never before the slide:
   * jumping to the twin position first would put the destination on screen
   * immediately and then animate away from it, so a click at the seam would
   * look like it skipped a card. See the module note in carousel.ts.
   *
   * The rewind lands on a position showing exactly the cards already on
   * screen, so `snapTo`'s lack of animation is invisible.
   *
   * Only a COMPLETED transition reaches here: an interrupted one fires
   * `transitioncancel` instead, so there is no partial-position case to
   * filter out. A person clicking faster than a slide therefore skips this
   * handler entirely — the rewind they owe is settled by `ringStep` at the
   * start of their next press, which snaps the same invisible twin.
   */
  const onSettle = useCallback((event: ReactTransitionEvent<HTMLDivElement>): void => {
    if (!ring) return
    // Guard against a bubble from a child's own transition — a card fades
    // its hover fill on `background-color`. The target check already covers
    // it; the property check keeps the guard honest if that ever changes.
    if (event.target !== trackRef.current) return
    if (event.propertyName !== 'transform') return
    const owed = rewindTo(posRef.current, n)
    if (owed === null) return
    posRef.current = owed
    snapTo(owed)
  }, [ring, n, snapTo])

  /** One step of the ring, from an arrow or from auto-rotation. */
  const step = useCallback((delta: number): void => {
    if (!ring || !ready) return
    // Every step — auto or manual — pushes the next auto tick a full interval
    // away. That is what keeps a tick from landing on a track that is still
    // travelling: a slide lasts SLIDE_MS, and an interval that fired on its
    // own clock would CANCEL it mid-flight and restart from wherever the track
    // happened to be, so the arriving card never finishes its curve and the
    // motion stutters. Starting the clock from the last step also means a
    // person clicking the arrows does not get an immediate auto-advance on
    // top of their own click.
    bumpAutoplay()
    // `ringStep` settles any rewind still owed first, so a second press
    // during the animation cannot walk the window off the rendered copies.
    const { from, to } = ringStep(posRef.current, delta, n)
    if (from !== posRef.current) {
      posRef.current = from
      snapTo(from)
    }
    posRef.current = to
    // No frame gap before the slide: `snapTo` wrote `transition: none` and
    // `slideTo` writes the curve back, so this one call both re-arms the
    // transition and sets the destination. Deferring it with
    // `requestAnimationFrame` would do the same work a frame later, starting
    // every press one frame late for nothing.
    slideTo(to)
  }, [ring, ready, n, snapTo, slideTo, bumpAutoplay])

  // Publish `step` for the scheduler. In an effect, not during render: writing
  // a ref while rendering is a side effect React may run twice under StrictMode
  // and would rather not see at all.
  useEffect(() => { latestStepRef.current = step }, [step])

  // Auto-rotation. The predicate owns every reason to stop; this effect only
  // schedules the FIRST tick. Each step reschedules the next (see `step`), so
  // the cadence is measured from the last move rather than from page load.
  //
  // A timeout, not `setInterval`: an interval fires on its own clock and does
  // not know a slide is still in flight. The cadence is `AUTOPLAY_INTERVAL_MS`
  // measured from the last step, so the strip is still for
  // `AUTOPLAY_INTERVAL_MS - SLIDE_MS` between sweeps — see the pacing note in
  // autoplay.ts for why the interval is the budget for a whole card, not the
  // gap between them.
  useEffect(() => {
    if (!autoplayActive({ ring, ready, engaged, reducedMotion, visible })) return
    bumpAutoplay()
    return () => { window.clearTimeout(autoplayTimerRef.current) }
  }, [ring, ready, engaged, reducedMotion, visible, bumpAutoplay])

  // The New-Session window, and only it. See the module note.
  if (!blank) return null
  if (n === 0) return null
  // The hero has not painted yet. Rendering nothing keeps the strip from
  // appearing in the dock band for a frame and then jumping into the hero.
  if (mount === null) return null

  // Rendered COPIES times so the window always has neighbours to slide into;
  // a five-card ring cannot show positions 2 and 3 from a single copy.
  const cards = ring
    ? Array.from({ length: ringLength(n) }, (_, i) => SUGGESTIONS[i % n]!)
    : SUGGESTIONS

  const strip = (
    <div
      ref={viewportRef}
      data-aishell-suggestions={n}
      style={{
        // The clip the ring slides inside. `overflow: hidden` on a
        // transform-based track gives the ring clean edges: the next card is
        // already rendered one step away, so there is never a gap to fill.
        overflow: 'hidden',
        minWidth: 0,
        flex: '1 1 auto',
        // The cards size themselves against THIS element, not the track.
        // A percentage flex-basis would resolve against the track — which is
        // `max-content` wide, so every card would be as wide as all twelve.
        // A container query gives the cards a length (`cqw`) that means "this
        // element's width" with no JS measurement and no resize observer.
        containerType: 'inline-size',
      }}
    >
      <div
        ref={trackRef}
        data-aishell-suggestion-track={ring ? 'ring' : 'flat'}
        onTransitionEnd={onSettle}
        style={{
          display: 'flex',
          alignItems: 'stretch',
          gap: 'var(--dsh-suggestion-gap)',
          // `width: max-content` is load-bearing on a ring. The track is a
          // flex child of a flex row, so without it the track is sized to the
          // viewport and the twelve cards are squeezed into three slots —
          // cards stay 1/3 of the VIEWPORT and the ring never has anything to
          // slide to. max-content sizes it to the cards it actually holds.
          width: 'max-content',
          // The track is as wide as the cards it holds, and travels by
          // transform. A translate is composited, so the slide stays smooth
          // where a scrollLeft animation would repaint each frame.
          willChange: 'transform',
          // `transform` and `transition` are NOT here on purpose — the
          // imperative code owns them. See the SLIDE_MS note above: a value
          // declared here is only re-applied when React sees it change, so
          // the first imperative write would strip it permanently and the
          // slide would become a hard cut.
        }}
      >
        {cards.map((suggestion, i) => (
          <Card
            // The same card appears in every copy, so the index is part of
            // the key — `id` alone would collide across copies.
            key={`${i}:${suggestion.id}`}
            suggestion={suggestion}
            onPick={setDraft}
            t={t}
          />
        ))}
      </div>
    </div>
  )

  return createPortal(
    <div
      // Hover and keyboard focus both pause auto-rotation: reacting on
      // `focusin`/`focusout` (which is what React's onFocus/onBlur map to)
      // covers the reader who tabs to a card, not just the one with a pointer.
      onPointerEnter={() => { setEngaged(true) }}
      onPointerLeave={() => { setEngaged(false) }}
      onFocus={() => { setEngaged(true) }}
      onBlur={(event) => {
        // Moving focus between two cards inside the strip raises blur then
        // focus; treating that as a disengage would let a tick fire in the
        // gap, so only a focus target OUTSIDE the strip ends the pause.
        const next = event.relatedTarget as Node | null
        if (next === null || !event.currentTarget.contains(next)) setEngaged(false)
      }}
      style={{
        // The gap is a CSS variable so both the flex basis in Card and the
        // measured step read one number.
        ['--dsh-suggestion-gap' as string]: '10px',
        display: 'flex',
        alignItems: 'center',
        gap: 6,
        minWidth: 0,
        // Breathing room, and the reason for it is structural rather than
        // decorative. The strip lives in the hero's own content div, and below
        // it sit the workspace row and then the input card, with an 8px
        // composer gap between them. The three are close enough that equal
        // spacing above and below would read as one packed column — a row of
        // boxes, then a bigger box — instead of a strip that belongs to the
        // hero.
        //
        // So the band is asymmetric: less space above, which keeps the strip
        // attached to the headline it illustrates, and more below, which
        // separates it from the composer. The exact numbers are asserted by
        // the render check.
        margin: '12px 0 22px',
      }}
    >
      {ring && ready && <Arrow direction="prev" label={t('suggestion.previous')} onClick={() => { step(-1) }} />}
      {strip}
      {ring && ready && <Arrow direction="next" label={t('suggestion.next')} onClick={() => { step(1) }} />}
    </div>,
    mount,
  )
}