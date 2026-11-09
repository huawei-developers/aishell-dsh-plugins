/**
 * The SVG's own size.
 *
 * D2 emits the outer `<svg>` with a `viewBox` and nothing else, and that is not
 * enough: an SVG with no `width`/`height` has no intrinsic size, so a browser
 * treats it as a replaced element and lays it out at the CSS default of
 * 300×150. The `viewBox` is then scaled into that box, which for a real account
 * is roughly 5000×1800 — a factor near 0.06, turning a 16px label into about
 * one pixel.
 *
 * The file was correct and still unreadable. These tests pin the size, because
 * the symptom (a preview that looks empty) points at the content rather than at
 * the attribute that decides how large the content is drawn.
 */

import { describe, it, expect } from 'vitest'

import { withIntrinsicSize } from '../src/d2-engine.ts'

/** The shape D2 actually emits: viewBox only, no width or height. */
const D2_OUTPUT = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 4966 1804">'
  + '<rect width="4966" height="1804"/></svg>'

describe('withIntrinsicSize', () => {
  it('declares the size the viewBox describes', () => {
    const sized = withIntrinsicSize(D2_OUTPUT)
    expect(sized).toContain('width="4966"')
    expect(sized).toContain('height="1804"')
    // The viewBox stays, so the drawing still scales to whatever box it lands in.
    expect(sized).toContain('viewBox="0 0 4966 1804"')
  })

  it('keeps the rest of the document byte-for-byte', () => {
    // The body is the picture. Rewriting anything past the outer tag would
    // corrupt it, so only the opening element is touched.
    const sized = withIntrinsicSize(D2_OUTPUT)
    const body = D2_OUTPUT.slice(D2_OUTPUT.indexOf('>') + 1)
    expect(sized.endsWith(body)).toBe(true)
  })

  it('is idempotent', () => {
    // Applied twice — by a caller and again by this module — the second pass
    // must not produce `width="1" width="1"` or refuse to render.
    const once = withIntrinsicSize(D2_OUTPUT)
    expect(withIntrinsicSize(once)).toBe(once)
  })

  it('leaves an SVG that already has a size alone', () => {
    const already = '<svg width="5" height="5" viewBox="0 0 5 5"><g/></svg>'
    expect(withIntrinsicSize(already)).toBe(already)
  })

  it('leaves an SVG with no viewBox alone', () => {
    // A wrong size is worse than the default: it would squash the drawing.
    const noBox = '<svg xmlns="http://www.w3.org/2000/svg"><g/></svg>'
    expect(withIntrinsicSize(noBox)).toBe(noBox)
  })

  it('leaves a degenerate viewBox alone', () => {
    for (const box of ['viewBox="0 0 0 0"', 'viewBox="0 0 -1 5"', 'viewBox="0 0 x y"']) {
      const svg = `<svg ${box}><g/></svg>`
      expect(withIntrinsicSize(svg), box).toBe(svg)
    }
  })

  it('does not invent a size for something that is not an SVG', () => {
    expect(withIntrinsicSize('not an svg at all')).toBe('not an svg at all')
  })
})