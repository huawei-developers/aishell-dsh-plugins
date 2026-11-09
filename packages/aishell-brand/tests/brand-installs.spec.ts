/**
 * Brand.tsx's three DOM installations and their disposers.
 *
 * These three reach outside React — a `<style>` tag, mouse listeners on a
 * host element, inserted nodes — so nothing unmounts them. They used to run at
 * module load, which leaked on every HMR reload: the client loader tears a
 * module down with `tearDownEntryFiber` (fiber effects) and `removeOwnedStyles`
 * (only `style[data-plugin]` tags), so a bare `MutationObserver` on
 * `document.body` is reachable by neither and accumulated one per reload.
 *
 * What this file pins, for each install:
 *   1. it applies its effect to a document it is handed;
 *   2. it returns a disposer, and that disposer actually reverses the effect —
 *      observer stopped, listeners off, nodes removed, attributes cleared;
 *   3. a second install is a no-op while the first is present (the `data-`
 *      markers), so re-running the factory does not double up.
 *
 * The stub DOM is driven directly: `StubMutationObserver.notify` runs the
 * observer body verbatim, and `dispatch` runs a listener the way the browser
 * would — so the assertions are on observable DOM state, not on call counts.
 */

import { describe, it, expect } from 'vitest'
import { installHeroPatchCss, installHeroHoverBridge, installPoweredBy } from '../src/client/Brand.tsx'
import { makeStubDocument, installStubGlobals, StubMutationObserver, record } from './stub-dom.ts'

/** A document with the hero markup the modules look for. */
function heroDocument(): { document: Document, headline: Element, titleSpan: Element } {
  const document = makeStubDocument()
  const stack = document.createElement('div')
  stack.className = 'stack'
  const headline = document.createElement('div')
  headline.className = 'headline'
  const titleGroup = document.createElement('div')
  titleGroup.className = 'titleGroup'
  const titleSpan = document.createElement('span')
  titleGroup.appendChild(titleSpan)
  headline.appendChild(titleGroup)
  stack.appendChild(headline)
  document.body.appendChild(stack)
  return { document, headline, titleSpan }
}

describe('installHeroPatchCss', () => {
  it('injects the patch style and removes it on dispose', () => {
    installStubGlobals()
    const document = makeStubDocument()

    const dispose = installHeroPatchCss(document)
    const tag = document.querySelector('style[data-aishell-hero-patch]')
    expect(tag).not.toBeNull()
    expect(tag!.textContent).toContain('--aishell-hero-title')

    dispose()
    expect(document.querySelector('style[data-aishell-hero-patch]')).toBeNull()
  })

  it('is a no-op while the tag is already present', () => {
    installStubGlobals()
    const document = makeStubDocument()
    installHeroPatchCss(document)
    const dispose = installHeroPatchCss(document)
    expect(document.querySelectorAll('style[data-aishell-hero-patch]')).toHaveLength(1)
    dispose()
  })
})

describe('installHeroHoverBridge', () => {
  it('toggles the logo class on hover, and the disposer stops it', () => {
    const uninstall = installStubGlobals()
    try {
      const { document, headline, titleSpan } = heroDocument()
      const fish = document.createElement('div')
      fish.className = 'fish'
      headline.appendChild(fish)

      const dispose = installHeroHoverBridge(document)
      expect((titleSpan as unknown as { dataset: Record<string, string> }).dataset.aishellHoverBridged).toBe('true')

      // Hovering is the whole point: the CSS sibling selector cannot reach
      // backwards, so this listener is what animates the mark.
      ;(titleSpan as unknown as { dispatch: (t: string) => void }).dispatch('mouseenter')
      expect((fish as unknown as { className: string }).className).toContain('aishell-logo-hover')
      ;(titleSpan as unknown as { dispatch: (t: string) => void }).dispatch('mouseleave')
      expect((fish as unknown as { className: string }).className).not.toContain('aishell-logo-hover')

      dispose()
      // Listeners off: the same events now do nothing.
      ;(titleSpan as unknown as { dispatch: (t: string) => void }).dispatch('mouseenter')
      expect((fish as unknown as { className: string }).className).not.toContain('aishell-logo-hover')
      // And the marker is cleared, so a later install can re-bridge.
      expect((titleSpan as unknown as { dataset: Record<string, string> }).dataset.aishellHoverBridged)
        .toBeUndefined()
    } finally {
      uninstall()
    }
  })

  it('stops its observer on dispose', () => {
    const uninstall = installStubGlobals()
    try {
      const { document } = heroDocument()
      const dispose = installHeroHoverBridge(document)
      const observer = StubMutationObserver.lastInstance!

      dispose()

      // After dispose the observer must not bridge a node that arrives later.
      const titleGroup = document.createElement('div')
      titleGroup.className = 'titleGroup'
      const lateSpan = document.createElement('span')
      titleGroup.appendChild(lateSpan)
      observer.notify([record({ type: 'childList', target: document.body, addedNodes: [titleGroup] })])
      expect((lateSpan as unknown as { dataset: Record<string, string> }).dataset.aishellHoverBridged)
        .toBeUndefined()
    } finally {
      uninstall()
    }
  })
})

describe('installPoweredBy', () => {
  it('inserts the label after the headline and removes it on dispose', () => {
    const uninstall = installStubGlobals()
    try {
      const { document, headline } = heroDocument()

      const dispose = installPoweredBy(document)
      const label = document.querySelector('[data-aishell-powered-by]')
      expect(label).not.toBeNull()
      expect(label!.textContent).toBe('Powered by deepseek-harness')

      dispose()
      expect(document.querySelector('[data-aishell-powered-by]')).toBeNull()
      // The headline itself is untouched — the label went *after* it.
      expect((headline as unknown as { childNodes: unknown[] }).childNodes.length).toBe(1)
    } finally {
      uninstall()
    }
  })

  it('does not insert a second label into the same stack', () => {
    const uninstall = installStubGlobals()
    try {
      const { document } = heroDocument()
      installPoweredBy(document)
      const dispose = installPoweredBy(document)
      expect(document.querySelectorAll('[data-aishell-powered-by]')).toHaveLength(1)
      dispose()
    } finally {
      uninstall()
    }
  })

  it('stops its observer on dispose', () => {
    const uninstall = installStubGlobals()
    try {
      const { document } = heroDocument()
      const dispose = installPoweredBy(document)
      const observer = StubMutationObserver.lastInstance!

      dispose()

      const stack = document.createElement('div')
      stack.className = 'stack'
      const headline = document.createElement('div')
      headline.className = 'headline'
      stack.appendChild(headline)
      document.body.appendChild(stack)
      observer.notify([record({ type: 'childList', target: document.body, addedNodes: [stack] })])
      expect(document.querySelector('[data-aishell-powered-by]')).toBeNull()
    } finally {
      uninstall()
    }
  })
})
