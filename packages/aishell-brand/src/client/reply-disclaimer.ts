/**
 * The standing notice that trails a reply.
 *
 * ## Why this is a DOM shadow and not a slot entry
 *
 * Chat publishes its per-Turn footer slot (`conversation.chat.turnTail`) only
 * once the Turn has ENDED — its node's `publication` is `immediate` on
 * `turn/end` and `none` on everything else. A notice registered there would be
 * absent for exactly the interval a reader is watching the answer being written,
 * which is when it matters most. The two anchors below are the only ones the
 * transcript publishes throughout: the running status while the Turn works, and
 * the footer once it closes. Shadowing both is what makes the notice continuous.
 *
 * ## Where it sits
 *
 * The notice is a CHILD of the anchor, inserted before the footer's action row.
 * That is the one position that reads correctly against both anchors: the footer
 * holds its Turn-tail slot and then the copy / like / dislike row, so the notice
 * lands as the reply's closing line with the controls below it; the running
 * status holds a single line, so there the notice simply follows it. Either way
 * it sits after everything the Turn said and above the things a reader can do
 * about it.
 *
 * Living inside the anchor rather than beside it is also what keeps the notice
 * singular. React replaces the anchor element as a Turn streams: a child goes
 * with the old node, while a sibling stays behind annotating an anchor that no
 * longer exists, and the next sweep adds a second notice beside the new one.
 *
 * ## Why it is inserted rather than templated into the host's markup
 *
 * The anchors are in the digest-protected dsh tree, and neither is a slot, so
 * there is nothing to register into. Injection follows the same shape as
 * `installPoweredBy` in Brand.tsx: a `MutationObserver` sweeps changed and
 * inserted subtrees, the element carries a marker so a re-scan is idempotent, and
 * the disposer removes every element it added plus the observer. React re-renders
 * these anchors continuously as a Turn streams, so one pass at mount would be
 * gone before the answer arrived — the sweep is what keeps the notice present.
 *
 * The string arrives through a `resolve` callback, not as a fixed value, and it
 * is read on every sweep. A notice lives as long as the Turn it annotates, and
 * that is longer than any one reading of the active language: a reader who
 * switches language keeps every answer already on screen, so the text beside
 * them has to follow. `locale.bind` resolves the active locale at CALL time,
 * which is what lets asking again be enough. The caller also subscribes to the
 * locale service, because a switch with nothing else mutating produces no
 * mutation to react to.
 *
 * @module @huaweidevtools/aishell-dsh-brand/client/reply-disclaimer
 */

/** The disposer stops the observer and removes every notice this install added. */
export type ReplyDisclaimerDisposer = () => void

/**
 * What the notice needs from the locale service to stay current.
 *
 * Narrowed to the one method used, so this module keeps no dependency on the
 * locale package and the spec can hand it a plain object.
 */
export interface LocaleChanges {
  /**
   * Subscribe to language changes.
   *
   * @param listener - called after the active locale changes.
   * @returns the unsubscribe.
   */
  subscribe: (listener: () => void) => () => void
}

/** Marker attribute on an inserted notice (exposed for the spec). */
export const REPLY_DISCLAIMER_MARKER = 'data-aishell-reply-disclaimer'

/**
 * The anchors a notice is placed inside, in the order the transcript publishes
 * them: the running status while a Turn works, the Turn footer once it closes. A
 * Turn only ever has one of the two, and they occupy the same slot.
 *
 * Two entries rather than one comma-separated selector: each is a literal
 * attribute its owner writes itself, so neither follows a base bump, and asking
 * for them separately keeps the walk readable and the stub DOM in this repo's
 * specs able to answer it.
 */
const ANCHORS: readonly string[] = ['[data-chat-running]', '[data-turn-tail]']

/** Every anchor inside one subtree, across {@link ANCHORS}. */
function anchorsIn(root: ParentNode): Element[] {
  const found: Element[] = []
  for (const selector of ANCHORS) found.push(...Array.from(root.querySelectorAll(selector)))
  return found
}

/**
 * The notice's own styling.
 *
 * Muted ink is the point — this is a caption, not a warning — and
 * `label-tertiary` is the shell's own rank for that (the action row's timestamps
 * use it). `label-quaternary` would be fainter but does not exist in the theme,
 * so a notice styled with it would silently inherit the full-strength ink.
 */
const NOTICE_STYLE = [
  // A row, so the glyph shares the text's baseline: the shell centres a glyph
  // beside a label this way in its own chips.
  'display: flex',
  'align-items: center',
  'gap: 6px',
  // No margin of its own. Both anchors are columns that already space their
  // children — the footer at 16px, the status tighter — so the notice inherits
  // that rhythm instead of adding to it.
  'margin: 0',
  'font-size: 12px',
  'line-height: 18px',
  'font-weight: 400',
  'color: var(--dsw-alias-label-tertiary, #81858c)',
  'user-select: none',
].join('; ')

/**
 * The sparkle that leads the notice.
 *
 * The shell's own `sparkle` glyph, inlined rather than referenced: a `<use
 * href="#dsw-icon-sparkle-regular">` would need that symbol present in the
 * page's sprite, which this element cannot rely on — it is injected from
 * outside the renderer that populates it. Inlining puts the geometry, the
 * stroke weight and the `currentColor` inheritance in one place, so the glyph
 * follows the notice's ink in either theme.
 *
 * Decorative, so `aria-hidden`: the text is the statement, and a screen reader
 * announcing an unnamed sparkle would add nothing to it.
 */
const SPARKLE_SVG = '<svg viewBox="0 0 16 16" width="12" height="12" fill="none" '
  + 'stroke="currentColor" stroke-width="1.5" aria-hidden="true" focusable="false">'
  + '<path d="M5.875 3C5.875 6.33333 7.54167 8 10.875 8C7.54167 8 5.875 9.66667 5.875 13'
  + 'C5.875 9.66667 4.20833 8 0.875 8C4.20833 8 5.875 6.33333 5.875 3Z"/>'
  + '<path d="M12.375 1.55823C12.375 3.39156 13.2917 4.30823 15.125 4.30823'
  + 'C13.2917 4.30823 12.375 5.22489 12.375 7.05823C12.375 5.22489 11.4583 4.30823 9.625 4.30823'
  + 'C11.4583 4.30823 12.375 3.39156 12.375 1.55823Z"/>'
  + '</svg>'

/**
 * The text node inside a notice: the label, as opposed to the glyph.
 *
 * A notice is the glyph's SVG followed by one text node, so the LAST text-node
 * child is the label. Reading `textContent` instead would work for display but
 * cannot be written back without replacing the glyph too.
 *
 * @param notice - a notice element.
 * @returns its label node, or null when it has none.
 */
function textOf(notice: Element): { data: string } | null {
  for (let index = notice.childNodes.length - 1; index >= 0; index -= 1) {
    const node = notice.childNodes[index] as unknown as { nodeType?: number, data?: unknown }
    if (node?.nodeType === 3 && typeof node.data === 'string') return node as { data: string }
  }
  return null
}

/**
 * The notice that belongs to one anchor, if any.
 *
 * A direct-child search: the notice is a child of the anchor, and a subtree
 * query would also descend into the notice's own inline SVG looking for a
 * marker that only the notice itself carries.
 *
 * @param anchor - the running status or the Turn footer.
 * @returns its notice, or null when it has none.
 */
function noticeInside(anchor: Element): Element | null {
  for (const child of Array.from(anchor.children)) {
    if (child.hasAttribute(REPLY_DISCLAIMER_MARKER)) return child
  }
  return null
}

/**
 * Place one notice inside one anchor — or bring an already-placed one up to
 * date.
 *
 * Both halves belong to the same call because both are triggered by the same
 * event: an anchor can come back under a different language, and re-reading the
 * text is cheaper than deciding whether it needs to be.
 *
 * The notice goes BEFORE the anchor's trailing action row, which is what puts
 * it under the reply and above the copy / like / dislike controls. Appending
 * would be simpler and wrong: the footer's last child is that row.
 *
 * @param anchor - the running status or the Turn footer.
 * @param resolve - reads the notice in the reader's current language.
 * @param factory - the owner document's createElement.
 * @param placed - every notice this install created, so the disposer can remove
 *   them.
 */
function placeNotice(
  anchor: Element,
  resolve: () => string,
  factory: Document,
  placed: Set<Element>,
): void {
  const text = resolve()
  // A caller with no dictionary entry for this language has nothing to say.
  if (text === '') return

  const existing = noticeInside(anchor)
  if (existing !== null) {
    // Only the TEXT node is rewritten, never `textContent`: assigning that
    // replaces every child, so it would drop the glyph and leave a bare line of
    // text behind after any language switch. Written only when it differs, so a
    // sweep over an unchanged Turn costs no layout.
    const label = textOf(existing)
    if (label !== null && label.data !== text) label.data = text
    return
  }

  const notice = factory.createElement('div')
  notice.setAttribute(REPLY_DISCLAIMER_MARKER, '')
  notice.setAttribute('style', NOTICE_STYLE)
  // The glyph is markup from this module's own constant, never from the string.
  notice.innerHTML = SPARKLE_SVG
  // The text is content: a translator's apostrophe or angle bracket must not be
  // able to change the markup, so it is a text node rather than parsed.
  notice.appendChild(factory.createTextNode(text))
  anchor.insertBefore(notice, actionRowOf(anchor))
  placed.add(notice)
}

/**
 * The action row a footer ends with, when it has one.
 *
 * The footer's markup is `<div data-turn-tail>` holding the slot anchor for
 * Turn-tail extensions and then the copy / branch / feedback row. The row is
 * identified by its `data-clock` attribute — a literal the shell writes itself,
 * unlike the class names beside it, which are CSS-module hashes.
 *
 * @param anchor - a Turn footer, or the running status.
 * @returns the row to insert before, or null to append.
 */
function actionRowOf(anchor: Element): Element | null {
  const row = anchor.querySelector('[data-clock]')
  // A row that is not a direct child is not the one this positions against.
  return row !== null && row.parentElement === anchor ? row : null
}

/**
 * Install the reply notice on a document.
 *
 * @param target - the document to patch.
 * @param resolve - reads the notice in the reader's current language. Called on
 *   every sweep, so a language switch reaches the Turns already on screen.
 * @param changes - optional source of "the language changed". When given, its
 *   notification re-sweeps, which is the only way an in-place switch reaches
 *   turns that nothing else mutates.
 * @returns the disposer, which stops the observer and the subscription, and
 *   removes every notice this install added (notices left by an earlier install
 *   are left alone, matching the symmetric-install rule the other shadows
 *   follow).
 */
export function installReplyDisclaimer(
  target: Document,
  resolve: () => string,
  changes?: LocaleChanges,
): ReplyDisclaimerDisposer {
  if (typeof target.querySelector !== 'function') return () => {}

  /**
   * Every notice this install created, so the disposer can take them all away.
   *
   * A `Set`: the sweep meets the same notice repeatedly, and a list would grow
   * an entry per pass. Nodes React discards stay here as dead references until
   * dispose — small, bounded by the Turns on screen, and cheaper than tracking
   * their removal.
   */
  const placed = new Set<Element>()

  const sweep = (root: ParentNode): void => {
    // The root itself may BE an anchor (a MutationObserver reports the added
    // node, not its parent), so both are scanned. The test is structural rather
    // than `instanceof Element`: these modules run where the document is handed
    // in and the global `Element` may not exist.
    const candidate = root as unknown as { matches?: (selector: string) => boolean }
    const matches = candidate.matches?.bind(candidate)
    if (matches !== undefined && ANCHORS.some((selector) => matches(selector))) {
      placeNotice(root as unknown as Element, resolve, target, placed)
    }
    for (const anchor of anchorsIn(root)) placeNotice(anchor, resolve, target, placed)
  }

  sweep(target)
  const observer = new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      // Both the mutation's target and whatever it inserted are swept. A stream
      // rewrites the target's subtree without inserting anything, that being the
      // case a refreshed string has to reach; a newly mounted anchor arrives with
      // its own children, which are under the inserted node rather than the
      // target.
      const root = mutation.target as ParentNode
      sweep(root)
      for (const node of mutation.addedNodes) {
        if (node.nodeType === 1) sweep(node as ParentNode)
      }
    }
  })
  observer.observe(target.body, { childList: true, subtree: true })
  const unsubscribe = changes === undefined ? undefined : changes.subscribe(() => { sweep(target) })

  return () => {
    observer.disconnect()
    unsubscribe?.()
    for (const notice of placed) notice.remove()
    placed.clear()
  }
}
