/**
 * The tab's data, kept outside React.
 *
 * One small store rather than per-component state because the list, the filter
 * bar, and the detail view all read the same catalogue, and a re-mount of any one
 * of them must not start another read of the repository.
 *
 * ## When it reads
 *
 * Twice by design, and never on a timer: once when the tab first renders, and
 * again when the person presses refresh. The upstream changes when a skill author
 * pushes — neither predictable nor urgent — so polling would spend a round trip
 * on every launch for a catalogue most sessions never open.
 *
 * The two reasons differ in what they ask for. The first read accepts the Host's
 * cached answer, because the tab is being opened and any recent one will do; the
 * refresh asks the Host to reach upstream, because the person has asked for the
 * newest answer in so many words. `refresh` in the request body carries that
 * difference.
 *
 * ## Why failures are kept as state, not thrown
 *
 * A failed read is not an empty catalogue. The Page has to say "could not load"
 * and offer a retry, because the action a person should take differs; rendering
 * the same empty list for both would send them looking for skills that exist.
 *
 * @module @huaweidevtools/aishell-dsh-huaweicloud-skills-market/client/store
 */

import type { MarketCatalog, MarketDetail, MarketRequest, MarketResponse, MarketSkill } from '../route.ts'
import { SKILLS_MARKET_CLIENT_ROUTE } from '../route.ts'

/** What the tab shows. */
export type MarketState =
  /** Nothing read yet; the first read is in flight. */
  | { readonly status: 'loading' }
  /** A catalogue is available. `refreshing` marks a read in flight over it. */
  | { readonly status: 'ready', readonly catalog: MarketCatalog, readonly refreshing: boolean }
  /** The read failed and there is no catalogue to show. */
  | { readonly status: 'failed', readonly message: string, readonly code: string }

/** What the detail view shows, when one is open. */
export type DetailState =
  | { readonly status: 'closed' }
  | { readonly status: 'loading', readonly name: string }
  | { readonly status: 'ready', readonly name: string, readonly detail: MarketDetail }
  | { readonly status: 'failed', readonly name: string, readonly message: string }

/** One skill's in-flight operation, so its own row can show progress. */
export interface RowActivity {
  readonly name: string
  readonly kind: 'install' | 'uninstall'
}

/**
 * The install-state filter.
 *
 * Its own control rather than a category chip: it answers a different question
 * ("what have I added?") and is the one filter a returning user reaches for
 * first, so it sits beside the search field rather than at the end of the
 * category rail.
 */
export type InstallFilter = 'all' | 'installed' | 'available'

/** Where a request goes; injected so a test can answer without the Host. */
export type Send = (request: MarketRequest) => Promise<MarketResponse>

/** Everything the components read and the actions they can take. */
export interface MarketStore {
  /** Current list state. */
  readonly state: MarketState
  /** The open detail page, if any. */
  readonly detail: DetailState
  /** The row currently working, if any. */
  readonly activity: RowActivity | undefined
  /** The last action's failure, shown beside the row that caused it. */
  readonly failure: { readonly name: string, readonly message: string } | undefined
  /** The search text, as typed. */
  readonly query: string
  /** The selected category, or undefined for all. */
  readonly category: string | undefined
  /** Which install states the list shows. */
  readonly installFilter: InstallFilter
  /** The page being shown, 0-based. */
  readonly page: number
  /** Whether the initial read has been started, so a remount does not repeat it. */
  readonly started: boolean

  /** Read the catalogue, starting the first read when nothing has been read. */
  refresh(): void
  /** Change the search text. */
  search(query: string): void
  /** Select a category, or undefined to clear. */
  filter(category: string | undefined): void
  /** Show only installed, only not-yet-installed, or everything. */
  filterInstall(filter: InstallFilter): void
  /** Show a page of the list, 0-based. */
  goToPage(page: number): void
  /** Install the named skill. */
  install(name: string): void
  /** Remove the named skill. */
  uninstall(name: string): void
  /** Open one skill's detail page. */
  openDetail(name: string): void
  /** Close the detail page. */
  closeDetail(): void
  /** Subscribe to state changes. */
  subscribe(listener: () => void): () => void
  /** The current snapshot; a stable reference while nothing changed. */
  snapshot(): MarketStore
}

/**
 * Send one request to the Host.
 *
 * Document-relative, so the request lands on the origin that served the page and
 * carries the browser session cookie the route's fence requires.
 *
 * @param request - the operation.
 * @returns the Host's answer.
 */
export async function sendToHost(request: MarketRequest): Promise<MarketResponse> {
  const response = await fetch(SKILLS_MARKET_CLIENT_ROUTE, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(request),
  })
  if (!response.ok) {
    return { ok: false, code: 'bad-request', message: `the skills market answered ${response.status}` }
  }
  return await response.json() as MarketResponse
}

/**
 * Create the store.
 *
 * @param send - the transport, defaulting to the Host route.
 * @returns the store.
 */
export function createMarketStore(send: Send = sendToHost): MarketStore {
  let state: MarketState = { status: 'loading' }
  let detail: DetailState = { status: 'closed' }
  let activity: RowActivity | undefined
  let failure: { name: string, message: string } | undefined
  let query = ''
  let category: string | undefined
  let installFilter: InstallFilter = 'all'
  /** The read in flight, so a second caller joins it rather than starting one. */
  let reading: Promise<void> | undefined
  /* One page at a time: a whole catalogue in one scroll is a great deal of DOM, and
     re-rendering all of it on each keystroke costs more than the page ever shows.
     A page is a fixed count whatever the catalogue size. */
  let page = 0
  let started = false
  let snapshot: MarketStore
  const listeners = new Set<() => void>()

  const emit = (): void => {
    snapshot = build()
    // A copy, not the live set: a listener that subscribes or unsubscribes while
    // being notified must not change the set being iterated. The copy is the
    // point of the code, so the rule that flags it is the rule that is wrong here.
    // oxlint-disable-next-line no-useless-spread
    for (const listener of [...listeners]) {
      try {
        listener()
      } catch {
        // A listener's failure must not starve the others.
      }
    }
  }

  const build = (): MarketStore => ({
    state,
    detail,
    activity,
    failure,
    query,
    category,
    installFilter,
    page,
    started,
    refresh: () => {
      // The tab's entry and the refresh control are the same action but not the
      // same request: the first read may answer from the Host's cache, the refresh
      // must reach upstream. `started` is what keeps a remount from starting a
      // second clone.
      const fresh = started
      if (!started) {
        started = true
        emit()
      }
      void read(fresh)
    },
    // A filter or a new query makes a different result set, which has no
    // "page 5": both return to the first page rather than landing past the end.
    search: (next) => { query = next; page = 0; emit() },
    filter: (next) => { category = next; page = 0; emit() },
    filterInstall: (next) => { installFilter = next; page = 0; emit() },
    goToPage: (next) => { page = next; emit() },
    install: (name) => { void act('install', name) },
    uninstall: (name) => { void act('uninstall', name) },
    openDetail: (name) => { void loadDetail(name) },
    closeDetail: () => { detail = { status: 'closed' }; emit() },
    subscribe: (listener) => {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    snapshot: () => snapshot,
  })

  /**
   * Read the catalogue, keeping what is on screen while the read runs.
   *
   * A read already in flight is the answer to a second request: the first read of
   * the session starts from the component's effect, so a refresh pressed before
   * that read settles would otherwise put two reads on the wire. The Host shares
   * one clone between them either way, but two answers racing would let the older
   * one land last.
   *
   * A refresh that fails over an existing catalogue keeps the catalogue: the
   * person loses the newest skills, not the list they were reading.
   */
  const read = async (fresh: boolean): Promise<void> => {
    if (reading !== undefined) {
      // A refresh asked for while an ordinary read is in flight is a different
      // request: the one in flight may have been answered from a cache the person
      // has just asked to bypass.
      if (!fresh) return reading
      await reading
    }
    reading = readOnce(fresh)
    try {
      await reading
    } finally {
      reading = undefined
    }
  }

  /**
   * One read, with the state transitions around it.
   *
   * @param fresh - whether the Host should reach upstream rather than answer from
   *   its cache. The tab's first read says no; the refresh control says yes.
   */
  const readOnce = async (fresh: boolean): Promise<void> => {
    if (state.status === 'ready') {
      state = { ...state, refreshing: true }
      emit()
    }
    const answer = await send(fresh ? { op: 'catalog', refresh: true } : { op: 'catalog' })
    if (answer.ok && answer.op === 'catalog') {
      state = { status: 'ready', catalog: answer.value, refreshing: false }
    } else if (!answer.ok && state.status !== 'ready') {
      state = { status: 'failed', message: answer.message, code: answer.code }
    } else if (!answer.ok && state.status === 'ready') {
      state = { ...state, refreshing: false }
      failure = { name: '', message: answer.message }
    }
    emit()
  }

  /**
   * Run an install or uninstall and fold its answer into the state.
   *
   * The Host answers with the catalogue as it stands after the action, so the
   * Page never re-reads to learn what it just did.
   *
   * @param kind - which action.
   * @param name - the skill.
   */
  const act = async (kind: 'install' | 'uninstall', name: string): Promise<void> => {
    if (activity !== undefined) return
    activity = { name, kind }
    failure = undefined
    emit()
    try {
      const answer = await send(kind === 'install' ? { op: 'install', name } : { op: 'uninstall', name })
      if (answer.ok && (answer.op === 'install' || answer.op === 'uninstall')) {
        state = { status: 'ready', catalog: answer.value, refreshing: false }
      } else if (!answer.ok) {
        failure = { name, message: answer.message }
      }
    } catch (error: unknown) {
      failure = { name, message: error instanceof Error ? error.message : String(error) }
    } finally {
      activity = undefined
      emit()
    }
  }

  /**
   * Read one skill's detail page.
   *
   * @param name - the skill.
   */
  const loadDetail = async (name: string): Promise<void> => {
    detail = { status: 'loading', name }
    emit()
    const answer = await send({ op: 'detail', name })
    // A second click while the first read runs must not have its page replaced
    // by the earlier answer.
    if (detail.status !== 'loading' || detail.name !== name) return
    if (answer.ok && answer.op === 'detail') {
      detail = { status: 'ready', name, detail: answer.value }
    } else if (!answer.ok) {
      detail = { status: 'failed', name, message: answer.message }
    }
    emit()
  }

  snapshot = build()
  return snapshot
}

/**
 * The skills a list should show, given the store's search and category.
 *
 * Filtering happens in the Page rather than on the Host: the whole catalogue is
 * already here, and a round trip per keystroke would be a worse experience than
 * the work it saves.
 *
 * @param skills - the catalogue's skills.
 * @param query - the search text.
 * @param category - the selected category, or undefined.
 * @returns the matching skills, in catalogue order.
 */
export function visibleSkills(
  skills: readonly MarketSkill[],
  query: string,
  category: string | undefined,
  installFilter: InstallFilter = 'all',
): MarketSkill[] {
  const needle = query.trim().toLowerCase()
  return skills.filter(skill => {
    if (installFilter === 'installed' && !skill.installed) return false
    if (installFilter === 'available' && skill.installed) return false
    if (category !== undefined && skill.category !== category) return false
    if (needle.length === 0) return true
    return skill.name.toLowerCase().includes(needle)
      || skill.description.toLowerCase().includes(needle)
      || skill.product.toLowerCase().includes(needle)
  })
}

/**
 * How many skills are installed, for the filter's own count.
 *
 * Derived from the catalogue rather than kept as a separate tally: the Host
 * answers each read with the install state, and a second counter could disagree
 * with it after an install the Page did not start.
 *
 * @param skills - the catalogue's skills.
 * @returns the installed count.
 */
export function installedCount(skills: readonly MarketSkill[]): number {
  return skills.filter(skill => skill.installed).length
}

/**
 * The categories the catalogue actually contains, in first-seen order.
 *
 * Derived per read rather than hard-coded: upstream adds and removes categories,
 * and a fixed list would offer filters that match nothing.
 *
 * @param skills - the catalogue's skills.
 * @returns category ids, sorted.
 */
export function categoriesOf(skills: readonly MarketSkill[]): string[] {
  return [...new Set(skills.map(skill => skill.category))].sort()
}
/**
 * How many skills one page shows.
 *
 * A whole catalogue in one column of DOM is many screens long, and every keystroke
 * in the search field would rebuild all of it. A page is a few rows at the wide
 * layout and about a screen at phone width — enough to browse, small enough that
 * one page is one screen's worth of work.
 */
export const PAGE_SIZE = 24

/**
 * The slice of a filtered list that one page shows, and the page count.
 *
 * @param skills - the already-filtered list.
 * @param page - the requested page, 0-based.
 * @returns the skills on that page and how many pages there are; the page is
 *   clamped, so a filter that leaves fewer pages still answers something.
 */
export function pageOf(
  skills: readonly MarketSkill[],
  page: number,
): { skills: readonly MarketSkill[], page: number, pageCount: number } {
  const pageCount = Math.max(1, Math.ceil(skills.length / PAGE_SIZE))
  const current = Math.min(Math.max(0, page), pageCount - 1)
  const start = current * PAGE_SIZE
  return { skills: skills.slice(start, start + PAGE_SIZE), page: current, pageCount }
}

/**
 * The tags a card shows for one skill.
 *
 * The card already states the category and the product, so those two come first
 * and the skill's own tags fill what is left. What is dropped, and why:
 *
 *   - the vendor name, which opens every upstream tag list and describes the
 *     page rather than the skill;
 *   - anything the card has already said;
 *   - phrases: some upstream tags are whole phrases, which are a sentence rather
 *     than a label.
 *
 * The cap is what a narrow card can hold on two rows without pushing its
 * neighbours' footers off the shared baseline. The skill's own page lists the
 * authored tags in full.
 *
 * @param skill - the catalogue entry.
 * @returns at most {@link MAX_CARD_TAGS} labels, category and product first.
 */
export const MAX_CARD_TAGS = 4

export function cardTags(skill: MarketSkill): string[] {
  const own = [skill.category, skill.product]
  const seen = new Set(own.map(label => label.toLowerCase()))
  const tags = [...own]
  for (const raw of skill.tags) {
    const tag = raw.trim()
    const key = tag.toLowerCase()
    if (key === 'huawei-cloud' || seen.has(key) || tag.length > 24) continue
    seen.add(key)
    tags.push(tag)
    if (tags.length >= MAX_CARD_TAGS) break
  }
  return tags
}
