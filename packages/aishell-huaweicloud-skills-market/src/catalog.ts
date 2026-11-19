/**
 * Keeping a working copy of the upstream skill repository, and reading the
 * catalogue out of it.
 *
 * ## Why a clone rather than an index or an archive
 *
 * The upstream repository publishes no index document: it is a tree of
 * `<category>/<product>/<skill>/SKILL.md` bundles, and a skill's name and
 * description are only in its own `SKILL.md`. Reading those over HTTP means one
 * request per skill, of which the repository has hundreds, and each answer is
 * rate-limited. A clone fetches the whole tree in one operation and leaves the
 * bundle contents on disk, so the same work serves discovery and installation.
 *
 * The mirror is tried first and GitHub second. `gitcode.com` is reachable where
 * `github.com` is not, and the two carry the same commit; whichever answers
 * first is the one kept.
 *
 * ## Why a git library and not the `git` executable
 *
 * Invoking `git` means the market does not work on a machine without it, and it
 * means quoting paths for a subprocess on Windows. `isomorphic-git` is pure
 * JavaScript in the Host process.
 *
 * The first clone carries the whole repository; a refresh carries only the
 * changed objects, which is why the operation a deployment actually repeats is
 * the cheap one.
 *
 * ## Why the refresh is manual
 *
 * The upstream changes when a skill author pushes, which is neither predictable
 * nor urgent. Polling would spend a network round trip on every launch for a
 * catalogue most sessions never open. The Page reads once on entry and offers a
 * refresh control; nothing here reads on a timer.
 *
 * @module @huaweidevtools/aishell-dsh-huaweicloud-skills-market/catalog
 */

import { existsSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import * as fs from 'node:fs'
import { join } from 'node:path'
import git from 'isomorphic-git'
import http from 'isomorphic-git/http/node'
import { parse as parseYaml } from 'yaml'

import type { MarketSkill } from './route.ts'

/**
 * Where the catalogue is cloned from, in the order they are tried.
 *
 * The mirror first: the same commit is served by both, and a deployment behind a
 * network that cannot reach GitHub is the case this order exists for. GitHub
 * second covers the mirror being down or a deployment that must not contact it.
 */
export const UPSTREAM_MIRRORS = [
  'https://gitcode.com/huaweicloud/huaweicloud-skills.git',
  'https://github.com/huaweicloud/huaweicloud-skills.git',
] as const

/** The branch a clone follows. */
export const UPSTREAM_BRANCH = 'master'

/** Where a bundle's source lives on the web, for the detail page's link. */
export function sourceUrlFor(path: string): string {
  return `https://github.com/huaweicloud/huaweicloud-skills/tree/${UPSTREAM_BRANCH}/${path}`
}

/**
 * Description characters carried to the Page.
 *
 * Upstream descriptions are routing prose written to make a model pick the
 * skill: often several sentences, occasionally a paragraph. A card shows a few
 * lines, and the full text is in the installed `SKILL.md`, which is what the
 * model reads. Truncating at the catalogue boundary keeps one skill's payload
 * bounded instead of shipping prose the Page cannot use.
 */
const DESCRIPTION_MAX_LENGTH = 300

/**
 * How long one catalogue read is reused.
 *
 * A read costs a fetch plus a walk of the whole repository, and the Page answers
 * four operations from one result. The repository changes when a skill author
 * pushes, which is neither predictable nor urgent, and the refresh control exists
 * for the case where it just changed.
 */
const CATALOG_TTL_MS = 60_000

/** One skill found in the working copy. */
export interface CatalogEntry {
  /** What the Page renders. */
  readonly skill: Omit<MarketSkill, 'installed'>
  /** Absolute path of the bundle directory in the working copy. */
  readonly directory: string
}

/** The outcome of one catalogue read. */
export interface CatalogRead {
  readonly entries: readonly CatalogEntry[]
  /** Why discovery failed, when it did. */
  readonly error?: string
}

/** Options for one catalogue over one working copy. */
export interface CatalogOptions {
  /** Where the working copy lives. */
  readonly workTree: string
  /** Mirror URLs tried in order; overridable so a test does not need the network. */
  readonly mirrors: readonly string[]
  /** The branch followed. */
  readonly branch: string
}

/**
 * One working copy of the upstream repository.
 *
 * A class rather than module state so a test can point it at a temporary
 * directory, and so two Hosts in one process cannot share a checkout.
 */
export class Catalog {
  private readonly options: CatalogOptions
  private inflight: Promise<CatalogRead> | undefined
  /** The last successful read, and when it was taken. */
  private lastGood: CatalogRead | undefined
  private readAt = 0
  /** The mirror the working copy came from, so a refresh asks the one that worked. */
  private mirror: string | undefined

  constructor(options: CatalogOptions) {
    this.options = options
  }

  /**
   * Read the catalogue, fetching upstream first when the working copy is absent.
   *
   * A working copy that exists is refreshed; nothing here is on a timer, so this
   * is called exactly when the person asks for it — page entry and the refresh
   * control.
   *
   * Concurrent calls share one read: a Page that renders twice, or two windows
   * open at once, must not start two clones into one directory.
   *
   * @returns the catalogue, or the failure that kept it from being read.
   */
  async read(): Promise<CatalogRead> {
    // A read costs a fetch plus a walk of the whole repository. The Page reads once
    // on entry and again when the person presses refresh, and answers its four
    // operations from that one result, so a read is reused for as long as it stays
    // fresh.
    const cached = this.lastGood
    if (cached !== undefined && Date.now() - this.readAt < CATALOG_TTL_MS) return cached
    const shared = this.inflight ?? this.refresh()
    if (this.inflight === undefined) {
      this.inflight = shared
      void shared.finally(() => { this.inflight = undefined }).catch(() => {})
    }
    const read = await shared
    // A failed read is not cached: the next caller should retry rather than be
    // told the catalogue is empty for the rest of the minute.
    if (read.error === undefined) {
      this.lastGood = read
      this.readAt = Date.now()
    }
    return read
  }

  /**
   * Release the memory this instance holds.
   *
   * The git operation of a read in flight cannot be cancelled — neither `fetch`
   * nor `clone` takes an abort signal — so this drops the cached answers and lets
   * the operation finish unwatched. What it does prevent is the next mount
   * adopting that stale work: a fresh instance starts its own read rather than
   * inheriting one that belongs to a row the loader has unloaded.
   */
  dispose(): void {
    this.lastGood = undefined
    this.readAt = 0
    this.inflight = undefined
  }

  /**
   * Discard the cached read, so the next call reaches upstream.
   *
   * The Page's refresh control means exactly this: the person has asked for the
   * newest answer, not for the one this process happens to hold.
   */
  invalidate(): void {
    this.lastGood = undefined
    this.readAt = 0
  }

  /** The bundle a name refers to, as of the last successful read. */
  private async refresh(): Promise<CatalogRead> {
    try {
      await this.sync()
    } catch (error: unknown) {
      // A usable working copy outlives a failed refresh: the person loses the
      // newest skills, not the list they were reading.
      if (!existsSync(join(this.options.workTree, 'skills'))) {
        return { entries: [], error: describeSyncFailure(error) }
      }
    }
    return { entries: discover(this.options.workTree) }
  }

  /**
   * Bring the working copy to the upstream branch tip.
   *
   * @throws when no mirror could be read and no working copy exists.
   */
  private async sync(): Promise<void> {
    const directory = this.options.workTree
    const present = existsSync(join(directory, '.git'))
    if (present) {
      const url = this.mirror ?? await this.rememberedMirror(directory)
      await git.fetch({
        fs, http, dir: directory, url, ref: this.options.branch,
        singleBranch: true, depth: 1,
      })
      await git.checkout({ fs, dir: directory, ref: this.options.branch, force: true })
      // The working copy is a cache of one upstream branch, so it holds exactly
      // what that branch lists: a checkout restores the files the fetched tree
      // names, and everything else is a leftover — a skill the upstream deleted,
      // or residue from an interrupted run — and is removed. Without that, the
      // catalogue keeps offering a skill that exists in no published tree.
      //
      // Reconciling is what makes an incremental refresh correct. isomorphic-git
      // offers no `reset --hard`, and a full re-clone would produce the same tree
      // at the cost of downloading everything again.
      await reconcileTree(directory)
      return
    }
    // A clone writes into an empty directory. Clearing first makes that the
    // starting condition whether or not anything survived a previous attempt.
    rmSync(directory, { recursive: true, force: true })
    let lastError: unknown
    for (const url of this.options.mirrors) {
      try {
        // Sequential on purpose: the mirrors are a fallback order, and a second
        // clone started before the first fails would race it for one directory.
        // oxlint-disable-next-line no-await-in-loop
        await git.clone({
          fs, http, dir: directory, url, ref: this.options.branch,
          singleBranch: true, depth: 1,
        })
        this.mirror = url
        return
      } catch (error: unknown) {
        lastError = error
        rmSync(directory, { recursive: true, force: true })
      }
    }
    throw lastError ?? new Error('no mirror served the skill catalogue')
  }

  /**
   * Read the remote the working copy already tracks.
   *
   * @param directory - the working copy.
   * @returns the mirror that produced it, or the first configured one.
   */
  private async rememberedMirror(directory: string): Promise<string> {
    if (this.mirror !== undefined) return this.mirror
    try {
      const remotes = await git.listRemotes({ fs, dir: directory })
      const url = remotes[0]?.url
      if (url !== undefined) {
        this.mirror = url
        return url
      }
    } catch {
      // A working copy without a readable remote is refreshed from the first
      // configured mirror, which is the one a fresh clone would try anyway.
    }
    return this.options.mirrors[0] ?? UPSTREAM_MIRRORS[0]
  }
}

/**
 * Remove working-copy paths the checked-out commit does not list.
 *
 * The working copy is a cache of one upstream branch, so anything not in that
 * branch's tree is a leftover — a skill the upstream deleted, or residue from an
 * interrupted earlier run. Directory walks bottom-up so a directory left empty by
 * the removals is itself removed.
 *
 * @param directory - the working copy.
 */
async function reconcileTree(directory: string): Promise<void> {
  const listed = new Set<string>()
  await git.walk({
    fs, dir: directory, trees: [git.TREE({ ref: 'HEAD' })],
    map: async (filepath, entries) => {
      const [entry] = entries
      if (entry == null) return
      if (await entry.type() !== 'tree') listed.add(filepath)
    },
  })
  for (const relative of workingFiles(directory)) {
    if (!listed.has(relative)) rmSync(join(directory, ...relative.split('/')), { force: true })
  }
  pruneEmptyDirectories(directory)
}

/**
 * Every file in a working copy, relative to it with `/` separators.
 *
 * `.git` is skipped: it is the store the tree was read from, not part of the
 * checkout.
 *
 * @param directory - the working copy.
 * @returns the paths.
 */
function workingFiles(directory: string): string[] {
  const paths: string[] = []
  const walk = (current: string, prefix: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      if (prefix === '' && entry.name === '.git') continue
      const relative = prefix === '' ? entry.name : `${prefix}/${entry.name}`
      if (entry.isDirectory()) walk(join(current, entry.name), relative)
      else paths.push(relative)
    }
  }
  walk(directory, '')
  return paths
}

/**
 * Remove directories left empty by a reconciliation.
 *
 * @param directory - the working copy.
 */
function pruneEmptyDirectories(directory: string): void {
  // Depth first: a child is decided before its parent, so a directory that is
  // empty only because its own children were removed is removed in the same pass.
  const walk = (current: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      if (entry.name === '.git') continue
      if (!entry.isDirectory()) continue
      const child = join(current, entry.name)
      walk(child)
      if (readdirSync(child).length === 0) rmSync(child, { recursive: true, force: true })
    }
  }
  walk(directory)
}

/**
 * Walk a working copy for skill bundles.
 *
 * Discovery is structural: a directory four levels down under `skills/` that
 * contains a `SKILL.md`. Nothing else in the repository is examined, and a
 * bundle whose frontmatter cannot be read is skipped rather than failing the
 * whole catalogue — one malformed skill must not hide the other 197.
 *
 * @param workTree - the working copy's root.
 * @returns the bundles found, sorted by name.
 */
export function discover(workTree: string): CatalogEntry[] {
  const skillsRoot = join(workTree, 'skills')
  const entries: CatalogEntry[] = []
  for (const category of directories(skillsRoot)) {
    for (const product of directories(join(skillsRoot, category))) {
      for (const bundle of directories(join(skillsRoot, category, product))) {
        const directory = join(skillsRoot, category, product, bundle)
        const path = ['skills', category, product, bundle].join('/')
        const skill = readSkill(directory, { category, product, path })
        if (skill !== undefined) entries.push({ skill, directory })
      }
    }
  }
  return entries.sort((left, right) => compare(left.skill.name, right.skill.name))
}

/**
 * Read one bundle's catalogue fields.
 *
 * The name comes from the frontmatter rather than the directory, because the
 * registry keys on the frontmatter: an install whose directory and frontmatter
 * disagree would land a bundle the model cannot see under the name the card
 * showed. Across the upstream repository the two agree for every bundle, one of
 * them only after YAML resolves a quoted spelling.
 *
 * @param directory - the bundle directory.
 * @param location - the path segments that identify it.
 * @returns the catalogue fields, or undefined when the bundle is unreadable or malformed.
 */
function readSkill(
  directory: string,
  location: { category: string, product: string, path: string },
): Omit<MarketSkill, 'installed'> | undefined {
  let raw: string
  try {
    raw = readFileSync(join(directory, 'SKILL.md'), 'utf8')
  } catch {
    return undefined
  }
  const frontmatter = splitFrontmatter(raw)
  if (frontmatter === undefined) return undefined
  let fields: unknown
  try {
    fields = parseYaml(frontmatter.header)
  } catch {
    return undefined
  }
  if (typeof fields !== 'object' || fields === null) return undefined
  const name = (fields as { name?: unknown }).name
  const description = (fields as { description?: unknown }).description
  if (typeof name !== 'string' || typeof description !== 'string') return undefined
  return {
    name,
    description: shorten(description.trim()),
    category: location.category,
    product: location.product,
    path: location.path,
    tags: readTags((fields as { tags?: unknown }).tags),
  }
}

/**
 * Read a frontmatter `tags` field into a list of strings.
 *
 * Upstream spellings vary — a YAML list, a comma-separated string, either with
 * quotes — so anything that is neither a string nor a list is treated as no tags
 * rather than as a reason to drop the skill. An entry that is not a string is
 * dropped the same way.
 *
 * @param value - the parsed frontmatter value.
 * @returns the tags, empty when there are none.
 */
function readTags(value: unknown): string[] {
  if (typeof value === 'string') {
    return value.split(',').map(tag => tag.trim()).filter(tag => tag.length > 0)
  }
  if (Array.isArray(value)) {
    return value.filter((tag): tag is string => typeof tag === 'string')
      .map(tag => tag.trim())
      .filter(tag => tag.length > 0)
  }
  return []
}

/**
 * Split a Markdown file into its YAML frontmatter and its body.
 *
 * Hand-rolled rather than run through a Markdown parser: the only question is
 * where the opening `---` block ends, and a parser would answer it while also
 * validating the whole document — which nothing here needs.
 *
 * @param raw - the file's contents.
 * @returns the frontmatter block and the body, or undefined when there is none.
 */
export function splitFrontmatter(raw: string): { header: string, body: string } | undefined {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(raw)
  if (match?.[1] === undefined) return undefined
  return { header: match[1], body: raw.slice(match[0].length) }
}

/**
 * Shorten a description to the catalogue's budget.
 *
 * Cut at a word boundary where one is near the limit, so a card does not end
 * mid-word; the ellipsis marks that there is more, which the detail page shows.
 *
 * @param description - the full description.
 * @returns the description, shortened when it exceeded the budget.
 */
export function shorten(description: string): string {
  const flat = description.replace(/\s+/g, ' ')
  if (flat.length <= DESCRIPTION_MAX_LENGTH) return flat
  const cut = flat.slice(0, DESCRIPTION_MAX_LENGTH)
  const boundary = cut.lastIndexOf(' ')
  return `${(boundary > DESCRIPTION_MAX_LENGTH * 0.6 ? cut.slice(0, boundary) : cut).trimEnd()}…`
}

/**
 * Subdirectories of a directory, sorted.
 *
 * @param path - the directory to read.
 * @returns its directory entries' names; empty when the directory is unreadable.
 */
function directories(path: string): string[] {
  try {
    return readdirSync(path, { withFileTypes: true })
      .filter(entry => entry.isDirectory())
      .map(entry => entry.name)
      .sort()
  } catch {
    return []
  }
}

/**
 * Order two names by code point.
 *
 * Not `localeCompare`: the catalogue's order must not depend on the Host's
 * locale, or two machines would list the same skills differently.
 *
 * @param left - one name.
 * @param right - the other.
 * @returns the comparison result.
 */
function compare(left: string, right: string): number {
  if (left < right) return -1
  if (left > right) return 1
  return 0
}

/**
 * Explain a sync failure in one sentence.
 *
 * @param error - whatever the git call threw.
 * @returns a message naming what could not be reached.
 */
export function describeSyncFailure(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  return `Could not read the skill catalogue (${message})`
}