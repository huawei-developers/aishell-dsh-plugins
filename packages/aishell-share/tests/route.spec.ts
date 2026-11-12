/**
 * The shared constants and the link grammar.
 *
 * Both halves import this module, so what it pulls in is a bundle-weight
 * decision as much as a correctness one: anything with a runtime here reaches
 * the Page as well as the Host.
 */

import { describe, expect, it } from 'vitest'

import { readSharePath, SESSION_KIND, SHARE_CLIENT_ROUTE, SHARE_ROUTE } from '../src/route.ts'

describe('routes', () => {
  it('registers an absolute path and addresses a relative one', () => {
    expect(SHARE_ROUTE).toBe('/api/aishell/share')
    expect(SHARE_CLIENT_ROUTE).toBe('api/aishell/share')
  })

  it('names one resource kind', () => {
    expect(SESSION_KIND).toBe('session')
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