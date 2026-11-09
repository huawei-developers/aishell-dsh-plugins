/**
 * Finding the hero's content area — the portal target the strip renders into.
 *
 * Worth testing without a browser because the failure is silent: if the walk
 * finds the wrong element, the cards render inside the conversation root
 * instead of the hero (the live page has TWO `_body` classes), or into a stale
 * node the hero has already replaced. Neither throws; the strip just appears
 * in the wrong place, or not at all, on some New Sessions.
 *
 * The stub DOM has no selector engine, which is why the module walks children
 * directly — that choice is what makes these cases expressible here.
 */

import { describe, it, expect } from 'vitest'
import { makeStubDocument } from './stub-dom.ts'
import { ensureHeroMount, findHeroContent, removeHeroMount } from '../src/client/hero-content.ts'

/**
 * A hero stack as the shell renders it: headline → label → body, already
 * attached to a document body.
 *
 * Elements come from `document.createElement`, as the other brand specs do, so
 * they carry the real `Element` type (and its `ownerDocument`).
 */
function heroStack(bodyClass = 'pXSMma_body') {
  const document = makeStubDocument()
  const stack = document.createElement('div')
  stack.className = 'pXSMma_stack'
  const headline = document.createElement('div')
  headline.className = 'pXSMma_headline'
  const label = document.createElement('div')
  label.className = 'aishell-powered-by'
  const body = document.createElement('div')
  body.className = bodyClass
  stack.appendChild(headline)
  stack.appendChild(label)
  stack.appendChild(body)
  document.body.appendChild(stack)
  return { document, stack, headline, label, body }
}

describe('findHeroContent', () => {
  it('finds the hero body under the headline', () => {
    const { document, body } = heroStack()
    expect(findHeroContent(document)).toBe(body)
  })

  it('ignores a decoy _body elsewhere on the page', () => {
    // The live page has both `wSkVaW_body` (the conversation root) and
    // `pXSMma_body` (the hero). A bare `[class*="_body"]` lookup takes
    // whichever comes first in document order, so this is the regression that
    // would put the cards under the conversation instead of the hero.
    //
    // The decoy is inserted FIRST, so document order alone would pick it.
    const document = makeStubDocument()
    const decoy = document.createElement('div')
    decoy.className = 'wSkVaW_body'
    document.body.appendChild(decoy)
    const stack = document.createElement('div')
    stack.className = 'pXSMma_stack'
    const headline = document.createElement('div')
    headline.className = 'pXSMma_headline'
    const body = document.createElement('div')
    body.className = 'pXSMma_body'
    stack.appendChild(headline)
    stack.appendChild(body)
    document.body.appendChild(stack)
    expect(findHeroContent(document)).toBe(body)
    expect(findHeroContent(document)).not.toBe(decoy)
  })

  it('returns null when the hero is not on screen', () => {
    // A session that already has messages has no hero. Not an error: the
    // caller renders nothing and the strip stays absent.
    expect(findHeroContent(makeStubDocument())).toBeNull()
  })

  it('returns null when the headline has no body sibling', () => {
    // Fail closed. A base bump that renames the class must hide the strip,
    // never leave it half-mounted somewhere it does not belong.
    const document = makeStubDocument()
    const stack = document.createElement('div')
    const headline = document.createElement('div')
    headline.className = 'pXSMma_headline'
    stack.appendChild(headline)
    document.body.appendChild(stack)
    expect(findHeroContent(document)).toBeNull()
  })

  it('does not descend into nested _body elements', () => {
    // Only the stack's OWN body child is the hero content. A nested one
    // belongs to some inner component and must not capture the strip.
    const { document, body } = heroStack()
    const nested = document.createElement('div')
    nested.className = 'inner_body'
    body.appendChild(nested)
    expect(findHeroContent(document)).toBe(body)
  })
})

describe('hero mount lifecycle', () => {
  it('creates one mount and reuses it', () => {
    const { document, body } = heroStack()
    const content = findHeroContent(document)!
    const first = ensureHeroMount(content)
    expect(first.hasAttribute('data-aishell-suggestions-mount')).toBe(true)
    // Idempotent: the observer rescans on every mutation, so a second call
    // that made a second mount would stack duplicate strips.
    expect(ensureHeroMount(content)).toBe(first)
    expect(body.children.length).toBe(1)
  })

  it('appends the mount to the hero body, leaving the shell nodes alone', () => {
    const { document, stack, headline, body } = heroStack()
    ensureHeroMount(findHeroContent(document)!)
    expect(body.children[0]!.hasAttribute('data-aishell-suggestions-mount')).toBe(true)
    // The headline and the "Powered by" label are the shell's; the mount must
    // sit after them, in the body, not replace or precede anything.
    expect(stack.children[0]).toBe(headline)
  })

  it('removes only its own mount', () => {
    const { document, stack, headline, body } = heroStack()
    const content = findHeroContent(document)!
    ensureHeroMount(content)
    removeHeroMount(content)
    expect(body.children.length).toBe(0)
    // The host div survives and stays where the shell put it: it belongs to
    // the shell and is reused on the next New Session.
    expect(body.className).toBe('pXSMma_body')
    expect(stack.children[0]).toBe(headline)
    // Still findable, so the next New Session portals into the same node
    // rather than needing the hero rebuilt.
    expect(findHeroContent(document)).toBe(body)
  })

  it('is a no-op when nothing was mounted', () => {
    const { document } = heroStack()
    expect(() => { removeHeroMount(findHeroContent(document)!) }).not.toThrow()
  })

  it('a mount survives the hero being torn down and rebuilt', () => {
    // The New Session hero is REPLACED, not reused: sending a first message
    // removes it, and the next New Session renders a fresh one. The strip is
    // unmounted and remounted with it, and each mount must land in the CURRENT
    // hero body — never in the detached one it replaced.
    const first = heroStack()
    const firstMount = ensureHeroMount(findHeroContent(first.document)!)

    // The hero goes away and a brand-new one appears in the same document.
    removeHeroMount(findHeroContent(first.document)!)
    first.stack.remove()
    const secondStack = first.document.createElement('div')
    secondStack.className = 'pXSMma_stack'
    const secondHeadline = first.document.createElement('div')
    secondHeadline.className = 'pXSMma_headline'
    const secondBody = first.document.createElement('div')
    secondBody.className = 'pXSMma_body'
    secondStack.appendChild(secondHeadline)
    secondStack.appendChild(secondBody)
    first.document.body.appendChild(secondStack)

    const secondMount = ensureHeroMount(findHeroContent(first.document)!)
    expect(secondMount).not.toBe(firstMount)
    expect(secondMount.parentElement).toBe(secondBody)
    // The old hero was never touched by the second install.
    expect(firstMount.parentElement).not.toBe(first.body)
  })

  it('reuses an existing mount rather than stacking a second one', () => {
    // Removing and re-adding the hero is not the only path: the strip also
    // unmounts when the session stops being blank, then remounts on the next
    // New Session while the SAME hero body is still in the DOM. A second
    // install there must find the first mount, not append a twin beside it —
    // two mounts would render two strips in one hero.
    const { document, body } = heroStack()
    const original = ensureHeroMount(findHeroContent(document)!)
    expect(ensureHeroMount(findHeroContent(document)!)).toBe(original)
    removeHeroMount(findHeroContent(document)!)
    expect(body.children.length).toBe(0)
    expect(ensureHeroMount(findHeroContent(document)!).hasAttribute('data-aishell-suggestions-mount')).toBe(true)
    expect(body.children.length).toBe(1)
  })
})