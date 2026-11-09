/**
 * Provider-row shadow behavior.
 *
 * ui-settings-models renders each configured provider as a row whose header
 * shows the display name and an Edit button — digest-protected, with no slot
 * for the identity half (the provider-card seat extends the area BELOW the
 * header, which is the part the aishell family no longer wants). What this
 * file pins is the DOM shadow that stands in for the old card extension:
 *
 *   1. a found row gets one status dot after the name, carrying the host
 *      credential dot's 8px geometry and the success/warn palette, with the
 *      readiness copy as its title — green for stored AK/SK, warn without;
 *   2. the row's Edit button is hidden (the row is read-only), and only
 *      that one button — the sweep locates it by the row's own display name
 *      in its aria-label, so a neighbor's controls are never touched;
 *   3. a row that re-renders after install is re-swept, and the readiness
 *      repaint is an attribute write, not a second dot;
 *   4. dispose restores the row exactly: dot removed, Edit button back.
 *
 * The rows are built like the host renders them (CSS-module hash classes,
 * matched by `[class*="…"]` substring), so the specs exercise the same
 * selectors the shadow ships.
 */

import { describe, it, expect } from 'vitest'
import {
  installProviderRowShadow,
  ROW_DOT_MARKER,
  ROW_EDIT_HIDDEN,
  ROW_DOT_CSS,
} from '../src/client/provider-row-shadow.ts'
import { PROVIDER_DISPLAY_NAME } from '../src/provider-name.ts'
import { zh } from '../src/client/locales.ts'
import { makeStubDocument, installStubGlobals, record, StubMutationObserver } from './stub-dom.ts'

/** The dot's hover copy, as the installer would derive it from `t`. */
const TITLES = { ok: zh['provider.ready'], warn: zh['provider.warn'] }

/** Build one provider row shaped like ModelsSection renders it. */
function makeRow(document: Document, displayName: string): HTMLLIElement {
  const row = document.createElement('li') as unknown as HTMLLIElement
  row.className = 'zGbnIq_rowCard'
  const head = document.createElement('div')
  head.className = 'zGbnIq_rowHead'
  const identity = document.createElement('span')
  identity.className = 'zGbnIq_rowIdentity'
  const name = document.createElement('span')
  name.className = 'zGbnIq_rowName'
  name.textContent = displayName
  identity.appendChild(name)
  const actions = document.createElement('span')
  actions.className = 'zGbnIq_rowActions'
  const edit = document.createElement('button')
  edit.setAttribute('aria-label', `编辑 ${displayName}`)
  edit.textContent = '编辑'
  actions.appendChild(edit)
  head.appendChild(identity)
  head.appendChild(actions)
  row.appendChild(head)
  document.body.appendChild(row)
  return row
}

describe('installProviderRowShadow', () => {
  it('adds the dot after the name and marks the row’s own Edit button hidden', () => {
    const uninstall = installStubGlobals()
    try {
      const document = makeStubDocument()
      makeRow(document, PROVIDER_DISPLAY_NAME)
      installProviderRowShadow(document, true, TITLES)
      const identity = document.body.querySelector('[class*="rowIdentity"]')!
      const dot = identity.querySelector(`[${ROW_DOT_MARKER}]`)!
      expect(dot.getAttribute(ROW_DOT_MARKER)).toBe('ok')
      expect(dot.getAttribute('title')).toBe(TITLES.ok)
      expect(identity.querySelector('[class*="rowName"]')!.textContent).toBe(PROVIDER_DISPLAY_NAME)
      const edit = document.body.querySelector('button')!
      expect(edit.hasAttribute(ROW_EDIT_HIDDEN)).toBe(true)
    } finally { uninstall() }
  })

  it('paints the warn posture without credentials', () => {
    const uninstall = installStubGlobals()
    try {
      const document = makeStubDocument()
      makeRow(document, PROVIDER_DISPLAY_NAME)
      installProviderRowShadow(document, false, TITLES)
      const dot = document.body.querySelector(`[${ROW_DOT_MARKER}]`)!
      expect(dot.getAttribute(ROW_DOT_MARKER)).toBe('warn')
      // The warn copy points at the chip, not at a settings page (there is
      // none) — the actionable half has to name a real affordance.
      expect(dot.getAttribute('title')).toBe(TITLES.warn)
      expect(dot.getAttribute('aria-label')).toBe(TITLES.warn)
    } finally { uninstall() }
  })

  it('injects the dot stylesheet once per install', () => {
    const uninstall = installStubGlobals()
    try {
      const document = makeStubDocument()
      makeRow(document, PROVIDER_DISPLAY_NAME)
      const dispose = installProviderRowShadow(document, true, TITLES)
      const style = document.head.querySelector(`[${ROW_DOT_MARKER}-css]`)!
      expect(style.textContent).toBe(ROW_DOT_CSS)
      dispose()
      expect(document.head.querySelector(`[${ROW_DOT_MARKER}-css]`)).toBeNull()
    } finally { uninstall() }
  })

  it('ignores another provider’s row entirely', () => {
    const uninstall = installStubGlobals()
    try {
      const document = makeStubDocument()
      makeRow(document, 'Other Provider')
      installProviderRowShadow(document, true, TITLES)
      expect(document.body.querySelector(`[${ROW_DOT_MARKER}]`)).toBeNull()
      const edit = document.body.querySelector('button')!
      expect(edit.hasAttribute(ROW_EDIT_HIDDEN)).toBe(false)
    } finally { uninstall() }
  })

  it('re-marks the Edit button when the page rebuilds the row header in place', () => {
    const uninstall = installStubGlobals()
    try {
      const document = makeStubDocument()
      const row = makeRow(document, PROVIDER_DISPLAY_NAME)
      installProviderRowShadow(document, true, TITLES)
      // React re-renders the header's actions span with a fresh button; the
      // old marked one leaves the DOM carrying nothing, the new one arrives
      // unmarked. The observer must re-run the row's shadow.
      const actions = row.querySelector('[class*="rowActions"]')!
      const fresh = document.createElement('button')
      fresh.setAttribute('aria-label', `编辑 ${PROVIDER_DISPLAY_NAME}`)
      fresh.textContent = '编辑'
      actions.appendChild(fresh)
      StubMutationObserver.lastInstance?.notify([
        record({ type: 'childList', target: actions as unknown as Node, addedNodes: [fresh as unknown as Node] }),
      ])
      expect(fresh.hasAttribute(ROW_EDIT_HIDDEN)).toBe(true)
    } finally { uninstall() }
  })

  it('re-sweeps a row that re-renders after install', () => {
    const uninstall = installStubGlobals()
    try {
      const document = makeStubDocument()
      installProviderRowShadow(document, true, TITLES)
      const row = makeRow(document, PROVIDER_DISPLAY_NAME)
      StubMutationObserver.lastInstance?.notify([
        record({ type: 'childList', target: document.body as unknown as Node, addedNodes: [row as unknown as Node] }),
      ])
      expect(document.body.querySelector(`[${ROW_DOT_MARKER}]`)).not.toBeNull()
      expect(document.body.querySelector('button')!.hasAttribute(ROW_EDIT_HIDDEN)).toBe(true)
    } finally { uninstall() }
  })

  it('repaints readiness as one attribute write, never a second dot', () => {
    const uninstall = installStubGlobals()
    try {
      const document = makeStubDocument()
      makeRow(document, PROVIDER_DISPLAY_NAME)
      installProviderRowShadow(document, true, TITLES)
      installProviderRowShadow(document, false, TITLES)
      const identity = document.body.querySelector('[class*="rowIdentity"]')!
      const dots = identity.querySelectorAll(`[${ROW_DOT_MARKER}]`)
      expect(dots).toHaveLength(1)
      expect(dots[0]!.getAttribute(ROW_DOT_MARKER)).toBe('warn')
    } finally { uninstall() }
  })

  it('dispose restores the row exactly: dot removed, Edit button back', () => {
    const uninstall = installStubGlobals()
    try {
      const document = makeStubDocument()
      makeRow(document, PROVIDER_DISPLAY_NAME)
      const dispose = installProviderRowShadow(document, true, TITLES)
      dispose()
      expect(document.body.querySelector(`[${ROW_DOT_MARKER}]`)).toBeNull()
      const edit = document.body.querySelector('button')!
      expect(edit.hasAttribute(ROW_EDIT_HIDDEN)).toBe(false)
    } finally { uninstall() }
  })

  it('returns a no-op disposer when the target has no DOM surface', () => {
    const dispose = installProviderRowShadow({} as Document, true, TITLES)
    expect(() => { dispose() }).not.toThrow()
  })
})

describe('ROW_DOT_CSS', () => {
  it('carries the host credential dot’s geometry and both palette states', () => {
    expect(ROW_DOT_CSS).toContain('width: 8px;')
    expect(ROW_DOT_CSS).toContain('border-radius: 50%;')
    expect(ROW_DOT_CSS).toContain('background: var(--dsw-alias-state-success-primary);')
    expect(ROW_DOT_CSS).toContain('background: var(--dsw-alias-state-warn-label);')
  })

  it('hides the marked Edit button with an important declaration', () => {
    // The button's own class declares `display: inline-flex`; an author
    // declaration beats the UA sheet's `[hidden] { display: none }`, so the
    // hide must be an !important rule rather than the hidden attribute.
    expect(ROW_DOT_CSS).toContain(`[${ROW_EDIT_HIDDEN}] {`)
    expect(ROW_DOT_CSS).toContain('display: none !important;')
  })

  it('anchors the dot rules on the row identity so the sheet cannot leak', () => {
    for (const rule of ROW_DOT_CSS.split('}')) {
      if (rule.trim() === '' || rule.trim().startsWith('@')) continue
      if (rule.includes(ROW_EDIT_HIDDEN)) continue
      expect(rule).toContain('[class*="rowIdentity"]')
    }
  })
})
