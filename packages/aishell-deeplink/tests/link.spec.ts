/**
 * The admission rules: what counts as one of our links.
 *
 * These decide silently, so the cases that must be dropped are asserted as
 * explicitly as the ones that must be admitted.
 */

import { describe, expect, it } from 'vitest'

import { admit, SCHEME } from '../src/link.ts'

describe('admit', () => {
  it('admits a link and splits off its family', () => {
    expect(admit('aishell://share/abc123')).toEqual({
      family: 'share',
      href: 'aishell://share/abc123',
    })
  })

  it('admits a link carrying a query', () => {
    expect(admit('aishell://share/abc123?v=1')).toEqual({
      family: 'share',
      href: 'aishell://share/abc123?v=1',
    })
  })

  it('keeps the path with the URL, not the family', () => {
    const admitted = admit('aishell://share/a/b')
    expect(admitted?.family).toBe('share')
    expect(new URL(admitted!.href).pathname).toBe('/a/b')
  })

  it('removes the fragment, which carries nothing this transport can use', () => {
    expect(admit('aishell://share/abc#section')?.href).toBe('aishell://share/abc')
  })

  it('keeps the query, which is part of the request', () => {
    expect(admit('aishell://share/abc?x=1#f')?.href).toBe('aishell://share/abc?x=1')
  })

  it('admits a link with no path at all', () => {
    expect(admit('aishell://share')).toEqual({ family: 'share', href: 'aishell://share' })
  })

  it('lowercases the family, because a non-special scheme keeps host case', () => {
    expect(admit('aishell://Share/abc')?.family).toBe('share')
    expect(admit('aishell://SHARE/abc')?.family).toBe('share')
  })

  it('drops a foreign scheme', () => {
    expect(admit('https://share/abc')).toBeUndefined()
    expect(admit('file:///tmp/x')).toBeUndefined()
  })

  it('drops a string that is not a URL', () => {
    expect(admit('not a url')).toBeUndefined()
    expect(admit('')).toBeUndefined()
  })

  it('drops a link with no family', () => {
    expect(admit('aishell:///abc')).toBeUndefined()
    expect(admit('aishell:abc')).toBeUndefined()
  })

  it('owns exactly one scheme', () => {
    expect(SCHEME).toBe('aishell:')
  })
})