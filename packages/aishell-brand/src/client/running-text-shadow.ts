/**
 * Running-status copy shadow for the branded distribution.
 *
 * ui-chat's locale dictionary names the live running line after DeepSeek's
 * own product language: zh "深度求索中" / "深度求索中，用时 {duration} ···",
 * en "Deep diving" / "Deep diving for {duration} ···". locale.register
 * throws on an already-claimed namespace, so the `chat` dictionary cannot
 * be re-registered — the shadow rewrites the rendered text instead.
 *
 * The row re-renders every second while a Turn runs (LIVE_RUN_CLOCK_
 * INTERVAL_MS = 1000), so a one-shot rewrite would flash the official
 * copy on every tick. A MutationObserver watches [data-chat-running]
 * subtrees — characterData for the second ticks, childList for mounts,
 * and the data-shimmer-text attribute because TextShimmer paints its
 * highlight layer through CSS `content: attr(data-shimmer-text)`: a text
 * node rewritten without the attribute would keep showing the old glyphs
 * every time the highlight sweeps across them.
 *
 * One substring replacement covers both keys: the duration form begins
 * with the same prefix as the bare form, so replacing "深度求索中" →
 * "思考中" and "Deep diving" → "Thinking" rewrites the long sentences
 * too. The row's aria-hidden status span carries the same text and sits
 * inside the same subtree, so it is covered by the same sweep. Duration
 * units and the "···" tail are the harness's own words, not product
 * branding, and pass through untouched.
 *
 * Shadowing is a default, not a force (plan §2.2): install() and the
 * disposer it returns are symmetric, so disabling the plugin restores
 * the official copy exactly.
 *
 * @module @huaweidevtools/aishell-dsh-brand/client/running-text-shadow
 */

/** The disposer stops the observer and restores the official copy; a no-op install returns this. */
export type RunningTextShadowDisposer = () => void

/** Official zh phrase, the prefix of both the bare and the duration forms. */
const OFFICIAL_ZH = '深度求索中'

/** Branded zh phrase (final copy: 思考中 / 思考中，用时 {duration} ···). */
const BRANDED_ZH = '思考中'

/** Official en phrase, the prefix of both the bare and the duration forms. */
const OFFICIAL_EN = 'Deep diving'

/** Branded en phrase (final copy: Thinking / Thinking for {duration} ···). */
const BRANDED_EN = 'Thinking'

/** The replacements, in order. */
const REPLACEMENTS: readonly (readonly [string, string])[] = [
  [OFFICIAL_ZH, BRANDED_ZH],
  [OFFICIAL_EN, BRANDED_EN],
]

/**
 * Rewrite the running-line copy inside a value.
 *
 * Every occurrence of either official phrase is replaced; a value without
 * them is returned as-is — the shadow never invents content.
 */
export function rebrandRunningText(value: string): string {
  let branded = value
  for (const [official, replacement] of REPLACEMENTS) {
    branded = branded.split(official).join(replacement)
  }
  return branded
}

/** Whether the node carries the running row's stable anchor attribute.
 *
 * Duck-typed on the attribute surface rather than `instanceof Element` so
 * the shadow works identically in the browser and under the specs' DOM
 * stub, which provides the attribute methods without the constructor. */
function isRunningRow(node: Node): node is Element {
  return node.nodeType === Node.ELEMENT_NODE && (node as Element).hasAttribute('data-chat-running')
}

/**
 * Rewrite one text node and the shimmer attribute of its parent.
 *
 * The attribute matters as much as the node: TextShimmer's decorative
 * layer draws `content: attr(data-shimmer-text)` rather than the node's
 * own text, so leaving it stale resurfaces the official copy every time
 * the highlight sweeps.
 */
function rewriteTextNode(node: Text): void {
  const branded = rebrandRunningText(node.data)
  if (branded === node.data) return
  node.data = branded
  const host = node.parentElement
  if (host !== null && host.hasAttribute('data-shimmer-text')) {
    host.setAttribute('data-shimmer-text', rebrandRunningText(host.getAttribute('data-shimmer-text') ?? ''))
  }
}

/**
 * Sweep a subtree for official copy, rewriting what it finds.
 *
 * The attribute-only pass matters too: TextShimmer sets the attribute to
 * the generated string while the text node itself renders null, so some
 * re-renders change only the attribute.
 */
function sweep(target: Document, root: ParentNode): void {
  const walker = target.createTreeWalker(root, NodeFilter.SHOW_TEXT)
  for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
    rewriteTextNode(node as Text)
  }
  for (const host of root.querySelectorAll('[data-shimmer-text]')) {
    const value = host.getAttribute('data-shimmer-text') ?? ''
    const branded = rebrandRunningText(value)
    if (branded !== value) host.setAttribute('data-shimmer-text', branded)
  }
}

/**
 * Install the running-text shadow on a document.
 *
 * Sweeps every mounted [data-chat-running] row once, then observes the
 * document body for new rows (childList) and their text/attribute
 * changes (characterData, data-shimmer-text) so the per-second re-renders
 * stay covered for as long as the row exists. Returns the disposer: the
 * observer stops and every live row is restored to its official copy.
 */
export function installRunningTextShadow(target: Document): RunningTextShadowDisposer {
  if (typeof target.querySelector !== 'function' || typeof MutationObserver !== 'function') return () => {}

  const rewriteRow = (row: Element): void => { sweep(target, row) }

  for (const row of target.querySelectorAll('[data-chat-running]')) rewriteRow(row)

  const observer = new MutationObserver(mutations => {
    for (const mutation of mutations) {
      if (mutation.type === 'characterData') {
        const node = mutation.target
        if (node.parentElement !== null && node.parentElement.closest('[data-chat-running]') !== null) {
          rewriteTextNode(node as Text)
        }
        continue
      }
      if (mutation.type === 'attributes') {
        const host = mutation.target
        if (host.nodeType === Node.ELEMENT_NODE) {
          const element = host as Element
          if (element.closest('[data-chat-running]') !== null) {
            const value = element.getAttribute('data-shimmer-text') ?? ''
            const branded = rebrandRunningText(value)
            if (branded !== value) element.setAttribute('data-shimmer-text', branded)
          }
        }
        continue
      }
      for (const node of mutation.addedNodes) {
        if (node.nodeType === Node.ELEMENT_NODE) {
          if (isRunningRow(node)) rewriteRow(node)
          else if (node.parentElement !== null && node.parentElement.closest('[data-chat-running]') !== null) {
            sweep(target, node.parentElement)
          }
        } else if (node.nodeType === Node.TEXT_NODE && node.parentElement !== null) {
          if (node.parentElement.closest('[data-chat-running]') !== null) rewriteTextNode(node as Text)
        }
      }
    }
  })
  observer.observe(target.body, {
    childList: true,
    subtree: true,
    characterData: true,
    attributeFilter: ['data-shimmer-text'],
  })

  return () => {
    observer.disconnect()
    for (const row of target.querySelectorAll('[data-chat-running]')) {
      const restore = (host: Element): void => {
        if (host.hasAttribute('data-shimmer-text')) {
          host.setAttribute('data-shimmer-text', unbrand(host.getAttribute('data-shimmer-text') ?? ''))
        }
      }
      restore(row)
      for (const host of row.querySelectorAll('[data-shimmer-text]')) restore(host)
      const walker = target.createTreeWalker(row, NodeFilter.SHOW_TEXT)
      for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
        const text = node as Text
        const restored = unbrand(text.data)
        if (restored !== text.data) text.data = restored
      }
    }
  }
}

/** The inverse rewrite, so the disposer restores the official copy exactly. */
function unbrand(value: string): string {
  let official = value
  for (const [from, to] of REPLACEMENTS) {
    official = official.split(to).join(from)
  }
  return official
}
