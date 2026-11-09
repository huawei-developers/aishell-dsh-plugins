/**
 * Window-title shadow behavior.
 *
 * The product title is baked into the digest-protected dsh tree at two
 * places (the served dist index.html and ui-layout's DocumentTitle
 * component), which the asar shell swap cannot reach. What this file
 * pins is the runtime shadow that stands in for both:
 *
 *   1. every `document.title` write gets the product name rewritten in
 *      flight — including the repeated writes DocumentTitle performs on
 *      each session/panel change, not just the initial page title;
 *   2. the session-title prefix ui-layout writes before the product
 *      name passes through untouched;
 *   3. a write without the product name lands verbatim — the shadow
 *      never invents content;
 *   4. dispose restores the original property descriptor and rewrites
 *      the live value back to its official form (plan §2.2: shadowing
 *      is a default, not a force — an unload leaves the shell exactly
 *      as it was found).
 *
 * The DOM is stubbed with the same shape `document.title` has for real:
 * a WebIDL accessor on the prototype with no own instance property. The
 * property-machinery under test (descriptor lookup, own-property
 * shadowing, delete restoring the prototype accessor) behaves
 * identically on the stub, which is why the module accepts the target
 * as a parameter.
 */

import { describe, it, expect } from 'vitest'
import { installTitleShadow, rebrandTitle } from '../src/client/title-shadow.ts'

/** The document.title accessor shape the browser actually provides. */
function makeDocument(initial: string): Document {
  let title = initial
  const proto = {
    get title(): string { return title },
    set title(value: string) { title = value },
  }
  return Object.create(proto) as Document
}

describe('rebrandTitle', () => {
  it('rewrites the product name wherever it appears', () => {
    expect(rebrandTitle('DeepSeek Harness')).toBe('AI Shell')
    expect(rebrandTitle('Deploy the site — DeepSeek Harness')).toBe('Deploy the site — AI Shell')
    expect(rebrandTitle('a DeepSeek Harness b DeepSeek Harness c')).toBe('a AI Shell b AI Shell c')
  })

  it('returns a value without the product name verbatim', () => {
    expect(rebrandTitle('Deploy the site')).toBe('Deploy the site')
    expect(rebrandTitle('')).toBe('')
  })
})

describe('installTitleShadow', () => {
  it('rewrites the initial title on install', () => {
    const doc = makeDocument('DeepSeek Harness')
    installTitleShadow(doc)
    expect(doc.title).toBe('AI Shell')
  })

  it('rewrites every later write the way DocumentTitle performs them', () => {
    const doc = makeDocument('DeepSeek Harness')
    installTitleShadow(doc)
    // ui-layout's DocumentTitle effect, on each session/panel change:
    doc.title = 'Deploy the site — DeepSeek Harness'
    expect(doc.title).toBe('Deploy the site — AI Shell')
    // ...and the bare product name it restores on unmount:
    doc.title = 'DeepSeek Harness'
    expect(doc.title).toBe('AI Shell')
  })

  it('leaves unrelated writes alone', () => {
    const doc = makeDocument('DeepSeek Harness')
    installTitleShadow(doc)
    doc.title = 'A custom title'
    expect(doc.title).toBe('A custom title')
  })

  it('dispose restores the official title behavior and value', () => {
    const doc = makeDocument('DeepSeek Harness')
    const dispose = installTitleShadow(doc)
    doc.title = 'Deploy the site — DeepSeek Harness'
    expect(doc.title).toBe('Deploy the site — AI Shell')

    dispose()

    // The live value is back to its official form...
    expect(doc.title).toBe('Deploy the site — DeepSeek Harness')
    // ...and later writes pass through unrewritten (native descriptor restored).
    doc.title = 'DeepSeek Harness'
    expect(doc.title).toBe('DeepSeek Harness')
    doc.title = 'Deploy the site — DeepSeek Harness'
    expect(doc.title).toBe('Deploy the site — DeepSeek Harness')
  })

  it('install is idempotent-ish: a second install over the first keeps shadowing', () => {
    const doc = makeDocument('DeepSeek Harness')
    const first = installTitleShadow(doc)
    const second = installTitleShadow(doc)
    doc.title = 'DeepSeek Harness'
    expect(doc.title).toBe('AI Shell')

    first()
    second()
    doc.title = 'DeepSeek Harness'
    expect(doc.title).toBe('DeepSeek Harness')
  })

  it('returns a no-op disposer when the target has no settable title', () => {
    const bare = {} as Document
    const dispose = installTitleShadow(bare)
    expect(() => { dispose() }).not.toThrow()
  })
})
