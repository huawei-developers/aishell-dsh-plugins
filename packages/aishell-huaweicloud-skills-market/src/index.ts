/**
 * Huawei Cloud skills market, Node half.
 *
 * One route answering four operations over one skill catalogue: list, read one
 * skill's detail, install, uninstall. Installing writes a bundle into the
 * directory the harness scans for skills; the harness's own provider discovers it
 * from there, so nothing here registers with `ctx.skills`.
 *
 * ## Why this is a market and not a skill provider
 *
 * A provider would make the plugin part of what a skill *is* — its lifecycle, its
 * caching, its merge order against every other source. The market's job is
 * narrower: show what upstream publishes, and move the chosen bundle into place.
 * After that the skill is an ordinary local skill, indistinguishable from one the
 * person authored. That separation is what lets the market be installed, removed,
 * or uninstalled per profile without touching any installed skill.
 *
 * @module @huaweidevtools/aishell-dsh-huaweicloud-skills-market
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import z from '@deepseek-ai/schemastery'
import type Schema from '@deepseek-ai/schemastery'
import type { Context } from '@deepseek-ai/cordis'
// Type-only: pulls the ctx.connection merge (the authenticated fetch registry).
import type {} from '@deepseek-ai/dsh-client-connection'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'

import { Catalog, describeSyncFailure, UPSTREAM_BRANCH, UPSTREAM_MIRRORS, sourceUrlFor, splitFrontmatter } from './catalog.ts'
import { installBundle, listInstalled, marketplacePaths, uninstallBundle } from './install.ts'
import {
  isSkillName,
  SKILLS_MARKET_ROUTE,
  type MarketCatalog,
  type MarketCode,
  type MarketDetail,
  type MarketRequest,
  type MarketResponse,
  type MarketSkill,
} from './route.ts'

export const name = 'aishell-huaweicloud-skills-market'

/**
 * Required services.
 *
 * `connection` is the only one: without it there is no route for the Page to
 * answer on. The skill registry is deliberately absent — this plugin neither
 * reads nor writes it.
 */
export const inject = ['connection']

/** Plugin config. */
export interface Config {
  /** The directory the harness scans for skills; defaults to `<host home>/skills`. */
  readonly skillsRoot?: string
  /**
   * Where the catalogue is cloned from, tried in order.
   *
   * Overridable so a deployment behind a network that serves a different mirror
   * does not have to patch this package, and so a test can point at a fixture.
   */
  readonly mirrors?: string[]
  /** The branch followed. */
  readonly branch?: string
}

/**
 * The schema for this entry's settings.
 *
 * `satisfies` rather than an annotation on the export: `z.object(...)` infers a
 * type naming the schema package by the path it resolved from this package's
 * tree, and a workspace holding two copies of that package makes the emitted
 * `.d.ts` point into a `.pnpm/<version>` directory a consumer does not have.
 * Checking the shape at the declaration keeps the published file portable.
 */
export const Config: Schema<Config> = z.object({
  skillsRoot: z.string(),
  mirrors: z.array(z.string()).default([...UPSTREAM_MIRRORS]),
  branch: z.string().default(UPSTREAM_BRANCH),
}) satisfies Schema<Config>

/**
 * The directory the harness scans for skills.
 *
 * Resolved through the same helper the filesystem skill provider uses, so an
 * install lands where that provider is already looking. Resolving it
 * independently — a second `DSH_HOME` read, a different fallback — would let the
 * two disagree, and then an install would succeed into a directory nothing scans.
 *
 * @param configured - an explicit override from the plugin config.
 * @returns the absolute skills root.
 */
export function resolveSkillsRoot(configured: string | undefined): string {
  return configured !== undefined && configured.length > 0
    ? configured
    : join(resolveDshHome(), 'skills')
}

/**
 * Where the working copy of the upstream repository lives.
 *
 * Under the host's data directory rather than beside the skills it serves: it is
 * a cache of a remote tree, rebuilt from nothing at any time, and keeping it
 * apart from the skills root means a person browsing that directory sees only
 * the skills they have.
 *
 * @returns the working copy's path; not created here.
 */
export function workTreePath(): string {
  return join(resolveDshHome(), 'cache', 'aishell-skills-market', 'repository')
}

/**
 * Mount the market: one route, one catalogue, no tools.
 *
 * @param ctx - the host context.
 * @param config - the entry's settings.
 */
export function apply(ctx: Context, config: Config = {} as Config): void {
  const skillsRoot = resolveSkillsRoot(config.skillsRoot)
  const paths = marketplacePaths(skillsRoot)
  const catalog = new Catalog({
    workTree: workTreePath(),
    mirrors: config.mirrors ?? [...UPSTREAM_MIRRORS],
    branch: config.branch ?? UPSTREAM_BRANCH,
  })
  // The plugin can be unloaded while a read is running; the instance is released
  // with the row so a later mount starts its own read rather than adopting one
  // that belongs to it.
  ctx.effect(() => () => { catalog.dispose() }, 'aishell-huaweicloud-skills-market: catalogue lifecycle')
  const log = ctx.logger('aishell-skills-market')

  /**
   * Build the Page's catalogue from one read.
   *
   * The install set is read from disk on every call rather than remembered: an
   * uninstall done by hand, or a bundle removed between two reads, must show up
   * as such. The directory scan is one `readdir` of the skills root.
   *
   * @param read - one catalogue read.
   * @returns what the Page renders, including why a read failed.
   */
  const toCatalog = (read: Awaited<ReturnType<Catalog['read']>>): MarketCatalog => {
    const installed = new Set(listInstalled(skillsRoot))
    const skills: MarketSkill[] = read.entries.map(entry => ({
      ...entry.skill,
      installed: installed.has(entry.skill.name),
    }))
    return {
      complete: read.error === undefined,
      ...read.error === undefined ? {} : { error: read.error },
      skills,
    }
  }

  /**
   * Answer one request.
   *
   * @param request - the parsed body.
   * @returns the answer the Page renders.
   */
  const handle = async (request: MarketRequest): Promise<MarketResponse> => {
    switch (request.op) {
      case 'catalog':
        if (request.refresh === true) catalog.invalidate()
        return { ok: true, op: 'catalog', value: toCatalog(await catalog.read()) }

      case 'detail': {
        const read = await catalog.read()
        const entry = read.entries.find(candidate => candidate.skill.name === request.name)
        if (entry === undefined) return refuse('unknown-skill', `no skill named "${request.name}" in the catalogue`)
        return { ok: true, op: 'detail', value: readDetail(entry.directory, entry.skill.path) }
      }

      case 'install': {
        if (!isSkillName(request.name)) return refuse('bad-request', `"${request.name}" is not a skill name`)
        const read = await catalog.read()
        const entry = read.entries.find(candidate => candidate.skill.name === request.name)
        if (entry === undefined) return refuse('unknown-skill', `no skill named "${request.name}" in the catalogue`)
        const outcome = installBundle(paths, request.name, entry.directory, {
          name: request.name,
          path: entry.skill.path,
          installedAt: new Date().toISOString(),
        })
        if (!outcome.ok) {
          return refuse(outcome.refusal.code, outcome.refusal.code === 'name-taken'
            ? `a skill named "${request.name}" already exists and was not installed from the market`
            : `"${request.name}" was not installed from the market, so it is left untouched`)
        }
        record(ctx, { action: 'skill.install', subject: request.name, outcome: 'granted', detail: entry.skill.path })
        // The answer carries the new state, so the Page does not re-read to learn
        // what it just did.
        return { ok: true, op: 'install', value: toCatalog(read) }
      }

      case 'uninstall': {
        if (!isSkillName(request.name)) return refuse('bad-request', `"${request.name}" is not a skill name`)
        const outcome = uninstallBundle(skillsRoot, request.name)
        if (!outcome.ok) {
          return refuse(outcome.refusal.code, `"${request.name}" was not installed from the market, so it is left untouched`)
        }
        record(ctx, { action: 'skill.uninstall', subject: request.name, outcome: 'revoked' })
        return { ok: true, op: 'uninstall', value: toCatalog(await catalog.read()) }
      }
    }
  }

  ctx.effect(() => ctx.connection.fetch.register({
    path: SKILLS_MARKET_ROUTE,
    methods: ['POST'],
    requestBody: 'buffered',
    fetch: async (request: Request): Promise<Response> => {
      let body: unknown
      try {
        body = await request.json()
      } catch {
        return Response.json(refuse('bad-request', 'the request body was not JSON'))
      }
      const parsed = readRequest(body)
      if (parsed === undefined) return Response.json(refuse('bad-request', 'the request named no known operation'))
      try {
        return Response.json(await handle(parsed))
      } catch (error: unknown) {
        // A thrown sync or install failure is the filesystem's, and it is not
        // fatal to the plugin: the Page reports it and offers the action again.
        log.warn(`skills market: ${String(error)}`)
        return Response.json(refuse('write-failed', String(error)))
      }
    },
  }), 'aishell-huaweicloud-skills-market: catalogue route')

  // A failed first clone must not leave the Page with a spinner that never
  // resolves; the failure is reported on the request that asked for it, and this
  // logs the rest so a deployment can see what its network refused.
  void catalog.read().then(
    read => { if (read.error !== undefined) log.warn(`skills market: ${read.error}`) },
    (error: unknown) => { log.warn(`skills market: ${describeSyncFailure(error)}`) },
  )
}

/**
 * Read one skill's detail page.
 *
 * The body is the bundle's own `SKILL.md` with its frontmatter removed: the
 * detail page shows the instructions the person would actually install, and the
 * frontmatter is catalogue metadata the card already renders.
 *
 * @param directory - the bundle in the working copy.
 * @param path - its repository path, for the source link.
 * @returns the detail content.
 */
function readDetail(directory: string, path: string): MarketDetail {
  // One read. A file without frontmatter is shown whole, and reading it a second
  // time would both cost the work twice and risk answering with different bytes
  // than the ones the split was made from.
  const raw = readText(join(directory, 'SKILL.md'))
  return {
    body: splitFrontmatter(raw)?.body ?? raw,
    sourceUrl: sourceUrlFor(path),
  }
}

/**
 * Read a file, answering an empty string when it cannot be read.
 *
 * A detail page that fails to read its own `SKILL.md` shows an empty body rather
 * than an error: the page is already open, and the source link still works.
 *
 * @param path - the file.
 * @returns its contents.
 */
function readText(path: string): string {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return ''
  }
}

/**
 * Validate a request body into a typed request.
 *
 * @param body - the parsed JSON.
 * @returns the request, or undefined when it names no operation this route knows.
 */
export function readRequest(body: unknown): MarketRequest | undefined {
  if (typeof body !== 'object' || body === null) return undefined
  const value = body as { op?: unknown, name?: unknown, refresh?: unknown }
  switch (value.op) {
    case 'catalog':
      // Only an explicit `true` refreshes: a body that omits the field reads the
      // catalogue as any other caller does.
      return value.refresh === true ? { op: 'catalog', refresh: true } : { op: 'catalog' }
    case 'detail':
    case 'install':
    case 'uninstall':
      return typeof value.name === 'string' ? { op: value.op, name: value.name } : undefined
    default:
      return undefined
  }
}

/**
 * Build a refusal answer.
 *
 * @param code - the stable failure name.
 * @param message - one sentence for the person.
 * @returns the answer.
 */
function refuse(code: MarketCode, message: string): MarketResponse {
  return { ok: false, code, message }
}

/**
 * Record an install or uninstall in the audit trail, when the deployment has one.
 *
 * The trail is optional by design: a deployment without `aishell-audit` loses the
 * record, not the install. That is why this is a plain `ctx.get` guarded by a
 * presence check rather than a declared dependency — the market works on its own.
 *
 * @param ctx - the host context.
 * @param action - the dotted action name.
 * @param subject - the skill name.
 * @param detail - the bundle path, for an install.
 */
/**
 * Record one action in the audit trail, when the deployment has one.
 *
 * The caller states the outcome rather than the helper deriving it from the
 * action's name: a name is prose, and a rule that reads `granted` out of its
 * spelling would answer wrongly the first time an action is called something
 * else.
 *
 * @param ctx - the host context.
 * @param event - the action, its subject, its direction, and any detail.
 */
function record(ctx: Context, event: {
  action: string
  subject: string
  outcome: 'granted' | 'revoked'
  detail?: string
}): void {
  const audit = ctx.get('audit') as { record?: (event: Record<string, unknown>) => void } | undefined
  if (audit?.record === undefined) return
  try {
    audit.record({
      action: event.action,
      subject: event.subject,
      outcome: event.outcome,
      actor: 'user',
      ...event.detail === undefined ? {} : { detail: { path: event.detail } },
    })
  } catch {
    // An audit failure never fails the action it describes; the audit plugin
    // reports its own inability to write.
  }
}