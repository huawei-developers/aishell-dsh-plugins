/**
 * The list's presentation rules: paging, the card's tag budget, and the
 * install-state filter.
 *
 * These are pure functions, deliberately: what a card or a page decides is what
 * a test can state without a browser, and what is pinned here is the behaviour a
 * reader notices — a page is a fixed size, a card never carries more labels than
 * it has room for, and "installed" means what the button beside it says.
 */

import { describe, expect, it } from 'vitest'

import type { MarketSkill } from '../src/route.ts'
import { cardTags, createMarketStore, installedCount, MAX_CARD_TAGS, PAGE_SIZE, pageOf, visibleSkills } from '../src/client/store.ts'

/** Build one catalogue entry with the defaults a test does not care about. */
function skill(name: string, extra: Partial<MarketSkill> = {}): MarketSkill {
  return {
    name,
    description: `${name} description`,
    category: 'storage',
    product: 'obs',
    path: `skills/storage/obs/${name}`,
    tags: [],
    installed: false,
    ...extra,
  }
}

/** A send that never settles until the test releases it. */
function gatedSend() {
  let release: ((value: unknown) => void) | undefined
  const calls: unknown[] = []
  const send = (request: { op: string }): Promise<unknown> => {
    calls.push(request)
    return new Promise(resolve => { release = resolve })
  }
  return {
    send,
    calls,
    async release(value: unknown = { ok: true, op: 'catalog', value: { complete: true, skills: [] } }) {
      release?.(value)
      // Two microtask turns: the awaited promise settles, then the store's own
      // bookkeeping after it.
      await Promise.resolve()
      await Promise.resolve()
    },
  }
}

describe('pageOf', () => {
  it('shows one page at a time and reports how many there are', () => {
    const all = Array.from({ length: 50 }, (_, index) => skill(`skill-${index}`))
    const first = pageOf(all, 0)

    expect(first.skills).toHaveLength(PAGE_SIZE)
    expect(first.page).toBe(0)
    expect(first.pageCount).toBe(Math.ceil(50 / PAGE_SIZE))
    expect(pageOf(all, 2).skills[0]?.name).toBe(`skill-${PAGE_SIZE * 2}`)
  })

  it('clamps a page past the end rather than answering empty', () => {
    // A filter can shrink the list under the page being shown; the last page is
    // the useful answer, not a blank screen.
    const all = Array.from({ length: 10 }, (_, index) => skill(`skill-${index}`))
    const page = pageOf(all, 5)

    expect(page.page).toBe(0)
    expect(page.skills).toHaveLength(10)
  })

  it('answers one page for an empty list', () => {
    // The empty state renders one page of nothing, not a pager with 0 pages.
    const page = pageOf([], 0)
    expect(page.skills).toEqual([])
    expect(page.pageCount).toBe(1)
    expect(page.page).toBe(0)
  })
})

describe('cardTags', () => {
  it("leads with the card's own facts", () => {
    expect(cardTags(skill('a', { category: 'computing', product: 'ecs' }))).toEqual(['computing', 'ecs'])
  })

  it('drops the vendor name, which describes the page rather than the skill', () => {
    // Measured upstream: every tag list opens with it.
    expect(cardTags(skill('a', { tags: ['huawei-cloud', 'npu', 'remote'] })))
      .toEqual(['storage', 'obs', 'npu', 'remote'])
  })

  it('drops a tag the card already states', () => {
    expect(cardTags(skill('a', { tags: ['obs', 'OBS', 'bucket'] })))
      .toEqual(['storage', 'obs', 'bucket'])
  })

  it('drops a phrase, keeping the labels a person scans', () => {
    // Measured upstream: the longest single tag is 69 characters.
    const phrase = 'huawei-cloud hss security inspection vulnerability baseline intrusion'
    expect(cardTags(skill('a', { tags: [phrase, 'kafka'] }))).toEqual(['storage', 'obs', 'kafka'])
  })

  it('caps the card at what it has room for', () => {
    // Measured upstream: at most eight tags on one skill.
    const eight = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h']
    expect(cardTags(skill('x', { tags: eight }))).toHaveLength(MAX_CARD_TAGS)
  })
})

describe('visibleSkills', () => {
  const catalogue = [
    skill('installed-one', { installed: true }),
    skill('free-one', { installed: false, category: 'storage' }),
    skill('free-two', { installed: false, category: 'computing', product: 'ecs' }),
  ]

  it('separates installed from not installed', () => {
    expect(visibleSkills(catalogue, '', undefined, 'installed').map(s => s.name)).toEqual(['installed-one'])
    expect(visibleSkills(catalogue, '', undefined, 'available').map(s => s.name)).toEqual(['free-one', 'free-two'])
    expect(visibleSkills(catalogue, '', undefined, 'all')).toHaveLength(3)
  })

  it('combines with the category and the search text', () => {
    expect(visibleSkills(catalogue, '', 'computing', 'available').map(s => s.name)).toEqual(['free-two'])
    expect(visibleSkills(catalogue, 'free', undefined, 'installed')).toEqual([])
  })

  it('defaults to every install state', () => {
    expect(visibleSkills(catalogue, '', undefined)).toHaveLength(3)
  })

  it('counts what is installed from the catalogue, not a second tally', () => {
    expect(installedCount(catalogue)).toBe(1)
  })
})

describe('the catalogue read', () => {
  it('joins a read already in flight instead of starting a second', async () => {
    // The session's first read starts from the component's effect, so a refresh
    // pressed before it settles must not put a second request on the wire — two
    // racing answers would let the older one land last.
    const gate = gatedSend()
    const store = createMarketStore(gate.send as never)

    store.refresh()
    store.refresh()

    expect(gate.calls).toHaveLength(1)

    await gate.release()
    expect(store.snapshot().state.status).toBe('ready')

    // Once it settles, a later refresh is a new read.
    store.refresh()
    expect(gate.calls).toHaveLength(2)
  })
})

describe('the refresh control', () => {
  it('reaches upstream, while the tab entry does not', async () => {
    // The first read may answer from the Host's cache; the refresh control must
    // not, or the cache would make the button a no-op.
    const sent: unknown[] = []
    const store = createMarketStore(async (request) => {
      sent.push(request)
      return { ok: true, op: 'catalog', value: { complete: true, skills: [] } }
    })

    store.refresh()
    await Promise.resolve()
    await Promise.resolve()
    expect(sent[0]).toEqual({ op: 'catalog' })

    store.refresh()
    await Promise.resolve()
    await Promise.resolve()
    expect(sent[1]).toEqual({ op: 'catalog', refresh: true })
  })
})
