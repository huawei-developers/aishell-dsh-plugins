/**
 * The route's contract: request validation and the name grammar.
 *
 * Both halves depend on these two functions — the Page to refuse a bad name
 * before sending it, the Host to refuse one before it becomes a directory — so
 * they are tested where they live rather than through the plugin.
 */

import { describe, expect, it } from 'vitest'

import { isSkillName, SKILLS_MARKET_CLIENT_ROUTE, SKILLS_MARKET_ROUTE } from '../src/route.ts'
import { readRequest } from '../src/index.ts'

describe('the route path', () => {
  it('names the cloud it serves', () => {
    // A generic `/api/aishell/skills-market` would claim a namespace this plugin
    // does not own, and a second market for another vendor could not coexist.
    expect(SKILLS_MARKET_ROUTE).toBe('/api/aishell/huaweicloud-skills-market')
  })

  it('has a document-relative form for the Page', () => {
    // The served index carries `<base href="./">`; a leading slash would leave
    // the origin that carries the session cookie.
    expect(SKILLS_MARKET_CLIENT_ROUTE).toBe(SKILLS_MARKET_ROUTE.slice(1))
  })
})

describe('isSkillName', () => {
  it('accepts kebab-case', () => {
    expect(isSkillName('huawei-cloud-obs-upload')).toBe(true)
    expect(isSkillName('a')).toBe(true)
    expect(isSkillName('a1-b2')).toBe(true)
  })

  it('refuses anything a directory name could escape with', () => {
    // This is the grammar that keeps an install inside the skills root: the
    // name becomes a directory there.
    for (const name of ['..', '../escape', 'a/b', 'a\\b', '', 'A', 'a_b', '-a', 'a-', 'a--b', ' a']) {
      expect(isSkillName(name), name).toBe(false)
    }
  })
})

describe('readRequest', () => {
  it('reads the three named operations', () => {
    expect(readRequest({ op: 'catalog' })).toEqual({ op: 'catalog' })
    expect(readRequest({ op: 'install', name: 'x' })).toEqual({ op: 'install', name: 'x' })
    expect(readRequest({ op: 'uninstall', name: 'x' })).toEqual({ op: 'uninstall', name: 'x' })
    expect(readRequest({ op: 'detail', name: 'x' })).toEqual({ op: 'detail', name: 'x' })
  })

  it('refuses a named operation without a name', () => {
    expect(readRequest({ op: 'install' })).toBeUndefined()
    expect(readRequest({ op: 'install', name: 42 })).toBeUndefined()
  })

  it('refuses a body that names no operation', () => {
    expect(readRequest(undefined)).toBeUndefined()
    expect(readRequest(null)).toBeUndefined()
    expect(readRequest('install')).toBeUndefined()
    expect(readRequest({})).toBeUndefined()
    expect(readRequest({ op: 'delete-everything' })).toBeUndefined()
  })
})