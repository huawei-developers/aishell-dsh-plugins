/**
 * The shared constants and the link grammar.
 *
 * Both halves import this module, so what it pulls in is a bundle-weight
 * decision as much as a correctness one: anything with a runtime here reaches
 * the Page as well as the Host.
 */

import { describe, expect, it } from 'vitest'

import { FAMILY, readShareId, readSharePath, SESSION_KIND, SHARE_CLIENT_ROUTE, SHARE_ROUTE } from '../src/route.ts'

describe('routes', () => {
  it('registers an absolute path and addresses a relative one', () => {
    expect(SHARE_ROUTE).toBe('/api/aishell/share')
    expect(SHARE_CLIENT_ROUTE).toBe('api/aishell/share')
  })

  it('names one resource kind', () => {
    expect(SESSION_KIND).toBe('session')
  })

  it('claims the family the links carry', () => {
    // The transport lowercases a hostname before claiming, so this is the form
    // every comparison is made against.
    expect(FAMILY).toBe('share')
    expect(FAMILY).toBe(FAMILY.toLowerCase())
  })
})

describe('readSharePath', () => {
  it('reads the kind and id', () => {
    expect(readSharePath(new URL('aishell://share/session/abc'))).toEqual({
      kind: 'session',
      id: 'abc',
    })
  })

  it('rejects a link with no kind or no id', () => {
    expect(readSharePath(new URL('aishell://share'))).toBeUndefined()
    expect(readSharePath(new URL('aishell://share/session'))).toBeUndefined()
  })

  it('takes everything after the kind as the id', () => {
    // The id is the service's to spell, and it may be a path of its own. The
    // parser splits at the first slash only, so a deeper link is not a shape
    // this build must learn again later.
    expect(readSharePath(new URL('aishell://share/session/a/b'))).toEqual({
      kind: 'session',
      id: 'a/b',
    })
  })

  it('refuses a link with a kind but no id', () => {
    expect(readSharePath(new URL('aishell://share/session/'))).toBeUndefined()
  })

  it('tolerates a trailing slash', () => {
    expect(readSharePath(new URL('aishell://share/session/abc/'))).toEqual({
      kind: 'session',
      id: 'abc',
    })
  })
})

describe('readShareId — the admission', () => {
  it('reads the id of a session link', () => {
    expect(readShareId('aishell://share/session/abc')).toBe('abc')
    expect(readShareId(new URL('aishell://share/session/a/b'))).toBe('a/b')
  })

  it('reads the family case-insensitively', () => {
    // A pasted link may arrive with any casing; the transport lowercases before
    // claiming, so this parser has to agree with it about what matched.
    expect(readShareId('AISHELL://SHARE/session/abc')).toBe('abc')
  })

  it('refuses a foreign URL whose path happens to have two segments', () => {
    // The failure this guards. The import field takes arbitrary clipboard text,
    // and a parser that only looked at the path would hand `b` and `b` to the
    // service as ids — lookups for resources nobody named.
    expect(readShareId('https://example.com/a/b')).toBeUndefined()
    expect(readShareId('file:///a/b')).toBeUndefined()
    expect(readShareId('https://docs.example.com/guide/intro')).toBeUndefined()
  })

  it('refuses a kind this build does not read', () => {
    // `share` is a family and the kind grows; an unreadable one is skipped
    // rather than reported, because the sender may be a newer version.
    expect(readShareId('aishell://share/file/f1')).toBeUndefined()
  })

  it('refuses text that is not a URL', () => {
    expect(readShareId('just text')).toBeUndefined()
    expect(readShareId('')).toBeUndefined()
  })
})