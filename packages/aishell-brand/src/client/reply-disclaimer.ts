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
 * The notice is the anchor's SIBLING, placed directly after it, because the
 * anchor is not one thing: it is the running status while the Turn works and the
 * Turn footer once it closes, and those two have unrelated inner layouts — the
 * status is a tight column holding one line, the footer a 16px-gap column
 * holding the action row. A child would land differently in each, and its
 * position relative to the action row would differ with it. A sibling in the
 * Turn flow has one relationship to the Turn instead of one to each anchor: the
 * line after whatever the Turn ends with.
 *
 * Both anchors trail the Turn's content, so the notice inherits that position and
 * is the last line at all times: the status moves down as rows are admitted, and
 * the footer takes the same place when the Turn closes. It follows the answer
 * rather than being pinned somewhere a growing transcript would run into.
 *
 * The flow spaces its rows by putting `--dsh-chat-flow-gap` as a top margin on
 * each, so the notice takes that same rhythm rather than a margin of its own.
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
 * The anchors a notice is placed after, in the order the transcript publishes
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
  'display: block',
  // The turn flow spaces its rows with `--dsh-chat-flow-gap` through a
  // `margin-top` on each one. Sitting last, the notice takes that same rhythm
  // rather than inventing a margin of its own.
  'margin-top: var(--dsh-chat-flow-gap, 4px)',
  // The action row pulls itself 6px left to tuck its ICON buttons against the
  // column edge; a line of text belongs on the edge itself.
  'margin-left: 0',
  'font-size: 12px',
  'line-height: 18px',
  'font-weight: 400',
  'color: var(--dsw-alias-label-tertiary, #81858c)',
  'user-select: none',
].join('; ')

/**
 * Place one notice immediately after one anchor, as its sibling — or bring an
 * already-placed one up to date.
 *
 * Both halves belong to the same call because both are triggered by the same
 * event: an anchor can come back under a different language, and re-reading the
 * text is cheaper than deciding whether it needs to be.
 *
 * @param anchor - the running status or the Turn footer.
 * @param resolve - reads the notice in the reader's current language.
 * @param factory - the owner document's createElement.
 * @param placed - every notice on the page, so the disposer can remove them.
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
  const following = anchor.nextElementSibling
  const existing = following !== null && following.hasAttribute(REPLY_DISCLAIMER_MARKER)
    ? following
    : null
  if (existing !== null) {
    // Written only when it differs, so a sweep over an unchanged Turn costs no
    // layout.
    if (existing.textContent !== text) existing.textContent = text
    return
  }
  const parent = anchor.parentElement
  // No parent means the anchor is a fragment root: nowhere for a sibling to go.
  if (parent === null) return
  const notice = factory.createElement('div')
  notice.setAttribute(REPLY_DISCLAIMER_MARKER, '')
  notice.setAttribute('style', NOTICE_STYLE)
  // Text via textContent, never innerHTML: the string comes from a locale
  // dictionary, and a translator's apostrophe or angle bracket must not be able
  // to change the markup.
  notice.textContent = text
  parent.insertBefore(notice, anchor.nextSibling)
  placed.add(notice)
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

  /** Every notice this install created. A `Set`, so a node React re-used cannot
   *  be recorded twice as the sweep runs again. */
  const placed = new Set<Element>()

  const sweep = (root: ParentNode): void => {
    // The root itself may BE an anchor (a MutationObserver reports the added
    // node, not its parent), so both are scanned. The test is structural rather
    // than `instanceof Element`: these modules run where the document is handed
    // in and the global `Element` may not exist.
    const candidate = root as unknown as { matches?: (selector: string) => boolean }
    if (typeof candidate.matches === 'function') {
      for (const selector of ANCHORS) {
        if (candidate.matches(selector)) placeNotice(root as unknown as Element, resolve, target, placed)
      }
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
