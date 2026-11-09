/**
 * Runtime shadow of the aishell provider's Models-page row.
 *
 * The Models page renders each configured provider as a row whose header
 * (`rowHead`) shows the display name followed by an Edit button this family
 * has no use for: the profile has no fields the host editor knows how to
 * write, and the row's directory entry names no api-key credential, so the
 * host header paints no status dot either. What the row should carry is the
 * one fact that matters — ready or not — and it reads better beside the name
 * than in a card below the header.
 *
 * The header lives in ui-settings-models, digest-protected with no slot for
 * the identity half (the `settings.models.provider-card` seat extends the area
 * BELOW the header, which is exactly the part this family does not want). The
 * shadow therefore works the way aishell-brand's host residues do: find the
 * row, patch the DOM. The row is located by its rendered name (the directory
 * entry's displayName, `PROVIDER_DISPLAY_NAME` — a literal both halves share);
 * the class names beside it are CSS-module hashes, so they are matched by the
 * same `[class*="…"]` substring selectors the hero patch already relies on.
 *
 * What the shadow does to a found row:
 *
 *   1. a status dot after the name — the host credential dot's own 8px
 *      geometry and success/warn colors, green when AK/SK are stored, warn
 *      when they are not, with the readiness copy (installer-supplied, so it
 *      follows the active locale) as its title;
 *   2. the row's Edit button is hidden — the row is read-only, and the only
 *      control the header keeps is whatever the host itself decides (Remove,
 *      for user-added rows; this family's row is not removable). The hide is
 *      a marker-keyed `display: none !important` rule, not the `hidden`
 *      attribute: the button's own class sets `display: inline-flex`, and an
 *      author declaration beats the UA sheet's `[hidden] { display: none }`,
 *      so the attribute alone leaves the button visible.
 *
 * The Models page re-renders the rows (credential saves, pushed
 * invalidations), so a MutationObserver keeps the shadow applied for as long
 * as the page exists. Shadowing is a default, not a force: install() and the
 * disposer it returns are symmetric, so disabling the plugin restores the
 * official row exactly — dot removed, Edit button back.
 *
 * @module @huaweidevtools/aishell-dsh-llm/client/provider-row-shadow
 */

import { PROVIDER_DISPLAY_NAME } from '../provider-name.ts'

/**
 * The disposer stops the observer, removes every dot the install added, and
 * restores every hidden Edit button; a no-op install returns this.
 */
export type ProviderRowShadowDisposer = () => void

/** Marker attribute the dot carries (exposed for the spec). */
export const ROW_DOT_MARKER = 'data-aishell-provider-dot'

/** Marker attribute a hidden Edit button carries (exposed for the spec). */
export const ROW_EDIT_HIDDEN = 'data-aishell-edit-hidden'

/** The dot's own CSS: the host credential dot's geometry and palette. */
export const ROW_DOT_CSS = [
  `[class*="rowIdentity"] [${ROW_DOT_MARKER}] {`,
  '  box-sizing: border-box;',
  '  border-radius: 50%;',
  '  flex: none;',
  '  width: 8px;',
  '  height: 8px;',
  '  display: inline-block;',
  '}',
  `[class*="rowIdentity"] [${ROW_DOT_MARKER}="ok"] {`,
  '  background: var(--dsw-alias-state-success-primary);',
  '}',
  `[class*="rowIdentity"] [${ROW_DOT_MARKER}="warn"] {`,
  '  background: var(--dsw-alias-state-warn-label);',
  '}',
  // The Edit-button hide. `display: none !important` is required: the
  // button's own class (secondaryButton) declares `display: inline-flex`,
  // which would beat both the UA sheet's `[hidden]` and any non-important
  // author rule here. The marker attribute alone stays as the sweep's and
  // the disposer's restore anchor.
  `[${ROW_EDIT_HIDDEN}] {`,
  '  display: none !important;',
  '}',
].join('\n')

/** Title copy for the dot, by readiness — supplied by the installer so it
 * follows the active locale (this module is a DOM patch with no locale seat
 * of its own). The warn state keeps the actionable half — where to enter
 * AK/SK — because that is the one thing a fresh user cannot guess; the ready
 * state needs nothing beyond itself. */
export interface ProviderRowTitles {
  /** Hover copy when AK/SK are stored. */
  readonly ok: string
  /** Hover copy when they are not. */
  readonly warn: string
}

/** Every Edit button an aishell row renders (there is ordinarily one; a
 * re-render that leaves a second copy gets both, so none stays visible). */
function findEditButtons(row: Element): readonly HTMLButtonElement[] {
  const actions = row.querySelector('[class*="rowActions"]')
  if (actions === null) return []
  const found: HTMLButtonElement[] = []
  for (const button of actions.querySelectorAll('button')) {
    // aria-label carries "编辑 <name>" (providerCopy) in zh; the label's
    // template in en is "Edit <name>". Match the row's own name so the
    // shadow cannot catch a neighbor's button, and fall back to the zh text
    // content for locales whose aria-label the host did not localize.
    const label = button.getAttribute('aria-label') ?? ''
    if (label.includes(PROVIDER_DISPLAY_NAME) || button.textContent === '编辑') {
      found.push(button as HTMLButtonElement)
    }
  }
  return found
}

/**
 * Whether `node` is an Element (`querySelectorAll` roots can be non-element
 * nodes like the Document, where the row check below simply answers false).
 */
function isElement(node: Node): node is Element {
  return node.nodeType === Node.ELEMENT_NODE
}

/**
 * Whether `node` is a provider row whose rendered name is ours.
 *
 * Duck-typed on the attribute surface rather than `instanceof Element` so
 * the shadow works identically in the browser and under the specs' DOM
 * stub, which provides the attribute methods without the constructor.
 */
function isProviderRow(node: Node): node is Element {
  if (node.nodeType !== Node.ELEMENT_NODE) return false
  const element = node as Element
  const name = element.querySelector('[class*="rowName"]')
  return name !== null && name.textContent === PROVIDER_DISPLAY_NAME
}

/**
 * Apply the shadow to one row: add the dot (or repaint an existing one) and
 * hide the Edit button. Idempotent — a second pass rewrites the dot's
 * readiness instead of stacking another one.
 *
 * `target` is the owning document, passed in because the stub DOM the specs
 * run on keeps no `ownerDocument` link.
 */
function shadowRow(row: Element, ready: boolean, titles: ProviderRowTitles, target: Document): void {
  const identity = row.querySelector('[class*="rowIdentity"]')
  if (identity === null) return

  const state = ready ? 'ok' : 'warn'
  const existing = identity.querySelector(`[${ROW_DOT_MARKER}]`)
  const dot = existing ?? target.createElement('span')
  dot.setAttribute(ROW_DOT_MARKER, state)
  dot.setAttribute('title', titles[state])
  dot.setAttribute('aria-label', titles[state])
  if (existing === null) {
    dot.setAttribute('role', 'img')
    identity.appendChild(dot)
  }

  for (const edit of findEditButtons(row)) edit.setAttribute(ROW_EDIT_HIDDEN, '')
}

/** Undo one row: remove the dot, restore the Edit button. */
function unshadowRow(row: Element): void {
  row.querySelectorAll(`[${ROW_DOT_MARKER}]`).forEach(dot => { dot.remove() })
  row.querySelectorAll(`[${ROW_EDIT_HIDDEN}]`).forEach(button => {
    button.removeAttribute(ROW_EDIT_HIDDEN)
  })
}

/**
 * Install the provider-row shadow on a document.
 *
 * `ready` is the credential fact as the browser half derives it from the
 * settings namespace `aishell-credentials` owns (see `client/index.ts`);
 * `titles` is the dot's hover copy in the active locale (the installer
 * translates; this module holds only the DOM work). Neither is read from any
 * store here, so a later credential save or locale switch is a reinstall with
 * the new values, not a re-derivation buried in here. Sweeps the page once,
 * then observes the body so re-rendered rows are covered too. Returns the
 * disposer that stops the observer and restores every row.
 */
export function installProviderRowShadow(
  target: Document,
  ready: boolean,
  titles: ProviderRowTitles,
): ProviderRowShadowDisposer {
  if (typeof target.querySelector !== 'function' || typeof MutationObserver !== 'function') {
    return () => {}
  }

  /** Run the shadow over every provider row at or below `root`. */
  const sweep = (root: ParentNode): void => {
    if (isElement(root) && isProviderRow(root)) shadowRow(root, ready, titles, target)
    for (const row of root.querySelectorAll('[class*="rowCard"], [class*="setupCard"]')) {
      if (isProviderRow(row)) shadowRow(row, ready, titles, target)
    }
  }
  // A node re-rendered INSIDE a row (the header's buttons, for instance) is
  // up to several levels below the row element, so the climb walks the whole
  // ancestor chain and re-runs the shadow on every row found there — the
  // shadow itself is idempotent, and a node outside any row walks to the
  // body and sweeps nothing.
  const sweepIfRow = (node: Node): void => {
    if (isProviderRow(node)) { shadowRow(node, ready, titles, target); return }
    for (let parent = node.parentElement; parent !== null; parent = parent.parentElement) {
      sweep(parent)
    }
  }

  // The dot's CSS rides one style element per install: the readiness value
  // lives on the element (the attribute), not in the sheet, so a repaint is
  // an attribute write and the sheet never churns.
  const style = target.createElement('style')
  style.setAttribute(ROW_DOT_MARKER + '-css', '')
  style.textContent = ROW_DOT_CSS
  target.head.appendChild(style)

  sweep(target.body)

  const observer = new MutationObserver(mutations => {
    for (const mutation of mutations) {
      for (const node of mutation.addedNodes) {
        // Any node landing inside a provider row re-runs that row's shadow:
        // React may rebuild the header's buttons in place (a fresh Edit
        // button carries no marker), and the dot-and-marker write is
        // idempotent, so an over-broad re-sweep costs nothing.
        if (node.nodeType === Node.ELEMENT_NODE) sweepIfRow(node)
      }
    }
  })
  observer.observe(target.body, { childList: true, subtree: true })

  return () => {
    observer.disconnect()
    style.remove()
    for (const row of target.body.querySelectorAll('[class*="rowCard"], [class*="setupCard"]')) {
      if (isProviderRow(row)) unshadowRow(row)
    }
  }
}
