/**
 * Home-whale shadow behavior.
 *
 * ui-brand-official decorates the New-Session page with a canvas whale played
 * from a spritesheet on a click of blank home space. It cannot be withdrawn
 * through the slot system — `conversation.hero.frame` is an `hoc`, which
 * composes every registered layer and gives none the power to decline another —
 * so it is shadowed by CSS. What this file pins:
 *
 *   1. the patch hides the canvas by the attribute ui-brand-official writes on
 *      it itself (`data-home-whale`), not by a CSS-module hash;
 *   2. the selector outranks the owner's `display: block`, so the rule does not
 *      depend on which stylesheet the loader adds last;
 *   3. it hides rather than fades: the decoration stops measuring and drawing
 *      once its box is empty, so nothing paints and nothing animates;
 *   4. install is idempotent and the disposer restores the official decoration.
 *
 * The CSS is asserted as text: the selector is the contract, and this module is
 * the only place the text exists.
 */

import { describe, expect, it } from 'vitest'

import {
  HOME_WHALE_PATCH_CSS,
  HOME_WHALE_PATCH_MARKER,
  installHomeWhaleShadow,
} from '../src/client/home-whale-shadow.ts'
import { makeStubDocument } from './stub-dom.ts'

describe('HOME_WHALE_PATCH_CSS', () => {
  it('hides the decoration by the attribute its owner writes', () => {
    expect(HOME_WHALE_PATCH_CSS).toContain('[data-home-whale] {')
    expect(HOME_WHALE_PATCH_CSS).toContain('display: none;')
  })

  it('outranks the owner rule, which sets display through a class', () => {
    // A lone attribute selector ties with a lone class selector at (0,1,0), and
    // a tie is broken by stylesheet order — which the client loader decides.
    // The extra compound selector makes the patch win in either order.
    expect(HOME_WHALE_PATCH_CSS).toMatch(/^:root \[data-home-whale\] \{/)
  })

  it('hides rather than fades, so the renderer stops drawing', () => {
    // The renderer lays its spritesheet out from the measured box and stops
    // when the box is empty. `opacity: 0` would leave it painting frames nobody
    // sees, which is the cost this shadow exists to avoid.
    expect(HOME_WHALE_PATCH_CSS).not.toContain('opacity')
    expect(HOME_WHALE_PATCH_CSS).not.toContain('visibility')
  })

  it('targets one attribute, not a class-name guess', () => {
    // A CSS-module hash would put this rule on whichever element happened to
    // match after a base bump; the owner writes this attribute itself.
    expect(HOME_WHALE_PATCH_CSS).not.toContain('class*=')
  })
})

describe('installHomeWhaleShadow', () => {
  it('injects the patch style into the head once and the disposer removes it', () => {
    const document = makeStubDocument()
    const dispose = installHomeWhaleShadow(document)

    const tag = document.head.querySelector(`style[${HOME_WHALE_PATCH_MARKER}]`)
    expect(tag).not.toBeNull()
    expect(tag?.textContent).toBe(HOME_WHALE_PATCH_CSS)

    dispose()
    expect(document.head.querySelector(`style[${HOME_WHALE_PATCH_MARKER}]`)).toBeNull()
  })

  it('a second install reuses the element', () => {
    const document = makeStubDocument()
    installHomeWhaleShadow(document)
    const dispose = installHomeWhaleShadow(document)

    expect(document.head.querySelectorAll(`style[${HOME_WHALE_PATCH_MARKER}]`)).toHaveLength(1)
    dispose()
  })

  it('returns a no-op disposer when the target has no DOM surface', () => {
    const dispose = installHomeWhaleShadow({} as Document)
    expect(() => { dispose() }).not.toThrow()
  })
})