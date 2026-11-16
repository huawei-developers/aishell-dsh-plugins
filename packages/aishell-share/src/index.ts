/**
 * Session sharing, Node half.
 *
 * Two operations the Page asks for, and nothing else:
 *
 *   - **share** — read a session, build its package, upload it, answer the link
 *   - **import** — read a package, rebuild it as a session the user owns
 *
 * Both cross a process boundary, so neither can live in the Page: reading a
 * session needs the session store, and creating one needs the persistence
 * writer. The claim itself happens in the Page (§7), where the transport
 * provides `aishellDeepLinks`.
 *
 * @module @huaweidevtools/aishell-dsh-share
 */

import { isAbsolute } from 'node:path'

import z from '@deepseek-ai/schemastery'
// Type-only: the schema's type is the default export's type; a value import
// cannot be read as a namespace, so the annotation needs this name.
import type Schema from '@deepseek-ai/schemastery'
import type { Context } from '@deepseek-ai/cordis'
// Type-only: pulls the ctx.connection merge (the authenticated fetch registry).
import type {} from '@deepseek-ai/dsh-client-connection'
// Type-only: pulls ctx.sessionQuery, ctx.sessionPersistence, ctx.sessions.
import type {} from '@deepseek-ai/dsh-session-query'
import type {} from '@deepseek-ai/dsh-session-persistence'
import { materializeAppendBatch, materializeCreateHeader, validateStoredEvents } from '@deepseek-ai/dsh-session-persistence'
import { SESSION_FORMAT_VERSION, type SessionHeader, type SessionId } from '@deepseek-ai/dsh-session'

import { buildPackage, readPackage, toStoredEvents, type SharePackage } from './package.ts'
import { cutForMessage, keepThrough } from './truncate.ts'
import { SESSION_KIND, SHARE_ROUTE } from './route.ts'
import { VERSION } from './version.ts'
import { createShare, readShare, type ServiceFailure } from './service.ts'
import { attachToWorkspace } from './attach.ts'

export const name = 'aishell-share'

/**
 * Required services.
 *
 * Each is load-bearing: without `sessionQuery` there is nothing to read out of
 * a conversation, without `sessionPersistence` nothing to write a copy into,
 * and without `connection` no route to answer the Page on.
 *
 * `sessions` is deliberately absent: this plugin never attaches to the live
 * store. An imported copy is a stored log, opened by whoever reads it through
 * the ordinary resume path.
 */
export const inject = ['connection', 'sessionQuery', 'sessionPersistence']

export { SHARE_CLIENT_ROUTE, SHARE_ROUTE } from './route.ts'

/** Plugin config. */
export interface Config {
  /**
   * The share service's base URL.
   *
   * No built-in value: the endpoint belongs to the deployment, and a default
   * would send a person's conversation to a host they never agreed to.
   */
  readonly serviceOrigin: string
}

/**
 * Settings schema for this entry.
 *
 * The schema is what makes `serviceOrigin` reach `apply` at all: cordis
 * validates the entry's config through it, and without one a row that omits
 * `config` hands `apply` a `null` — every call then fails on
 * `config.serviceOrigin` with nothing naming the missing setting.
 *
 * No default, for the reason stated above: the address a conversation is
 * uploaded to is the deployment's decision, and a value compiled into this
 * package would be one nobody chose. A deployment supplies it in the profile —
 * this bundle's own `cordis.patch.yml` does, reading an environment variable
 * first so an operator can repoint it without republishing.
 */
/**
 * The schema for this entry's settings.
 *
 * The `satisfies` rather than an annotation on the export: `z.object(...)`
 * infers a type that names the schema package by the path it resolved from this
 * package's tree, and a workspace holding two copies of that package makes the
 * emitted `.d.ts` point into a `.pnpm/<version>` directory a consumer does not
 * have. Checking the shape at the declaration keeps the published file
 * portable while still refusing a schema that does not describe `Config`.
 */
export const Config: Schema<Config> = z.object({
  serviceOrigin: z.string().required(),
})

/**
 * One request from the Page.
 *
 * Three operations on one route rather than three routes: all address the same
 * resource, and one handler keeps a request and its answer together.
 */
type ShareRequest =
  | {
    readonly op: 'share'
    readonly sessionId: string
    /**
     * The message the reader acted on, when the share started from one.
     *
     * The package then carries the conversation **through the Turn that message
     * belongs to** — not up to the message, because the action row lives at a
     * Turn's tail and a cut mid-turn drops the pairings the log needs (§5.7).
     * Absent, the whole conversation is shared.
     */
    readonly messageId?: string
  }
  | { readonly op: 'fetch', readonly id: string }
  | {
    readonly op: 'import'
    /**
     * The package the reader was shown, as it came from `fetch`.
     *
     * Sent back rather than re-read from the service. What the reader agreed
     * to is what was on screen, and fetching again could store something
     * else: the conversation behind a link is not promised to be immutable,
     * and an id that doubles as a one-time credential would already be spent
     * by the preview. Re-reading also sends the whole conversation twice.
     */
    readonly session: SharePackage
    /**
     * The **workspace directory** the imported session is filed under: the
     * path the reader picked, which the sidebar groups by.
     *
     * Not this application's own working directory, and not the sender's —
     * the copy belongs to whoever imports it.
     */
    readonly cwd: string
  }

/** What the Page receives back. */
type ShareResponse =
  | { readonly ok: true, readonly url: string }
  | { readonly ok: true, readonly session: SharePackage }
  | { readonly ok: true, readonly sessionId: string }
  | { readonly ok: false, readonly reason: ServiceFailure }

export function apply(ctx: Context, config: Config): void {
  const log = ctx.logger(name)

  /**
   * The session's events, in the form the package carries.
   *
   * @param sessionId - the conversation to read.
   * @param messageId - the message the reader acted on, when the share started
   *   from one. The log is then cut at that message's Turn.
   * @returns the package, or undefined when there is nothing shareable.
   */
  const readSession = async (sessionId: string, messageId?: string): Promise<SharePackage | undefined> => {
    const snapshot = await ctx.sessionQuery.readSession(sessionId as never).catch(() => undefined)
    if (snapshot === undefined) return undefined
    const title = await ctx.sessionQuery.readTitle(sessionId as never).catch(() => undefined)

    let events = snapshot.events
    if (messageId !== undefined) {
      const cut = cutForMessage(events, messageId)
      // A message with no closed Turn behind it cannot be shared as a finished
      // conversation. Reported as a bad request rather than shared whole: the
      // reader asked for a prefix, and sending everything would disclose more
      // than they chose.
      if (!cut.ok) {
        log.warn(`share refused: ${cut.reason} for message ${messageId}`)
        return undefined
      }
      events = keepThrough(events, cut.lastSeq)
    }

    return buildPackage({
      title: title?.title ?? 'Untitled session',
      createdAt: snapshot.session.createdAt ?? Date.now(),
      events,
    }, VERSION)
  }

  /**
   * Rebuild one package as a session this machine owns.
   *
   * The copy is **written to storage**, not attached to the live store. A
   * session that exists only in memory is not a session this machine owns: the
   * sidebar lists from persistence, and the first message resumes through
   * `sessionPersistence.open(id, 'write')`, so an in-memory copy disappears on
   * restart and rejects its own first prompt. Writing the log is also the
   * whole rebuild — opening it later is the ordinary resume path, the one a
   * session created yesterday takes.
   *
   * @param pkg - the conversation to rebuild.
   * @param cwd - the **workspace directory** the copy is filed under.
   * @param signal - the reader's cancellation, checked before the write commits.
   * @returns the new session's id, or undefined when the events did not validate
   *   or the reader cancelled.
   */
  const importPackage = async (pkg: SharePackage, cwd: string, signal: AbortSignal): Promise<string | undefined> => {
    const id = mintSessionId() as SessionId
    const header: SessionHeader = {
      version: SESSION_FORMAT_VERSION,
      id,
      createdAt: pkg.createdAt,
      // The header field is the host's name for the directory a session is
      // filed under, and it is required: the workspace registry indexes a
      // session by it, and a header without one is filed as invalid — the
      // session exists, but never appears in the sidebar.
      cwd,
      isSeeded: false,
    }
    const events = toStoredEvents(pkg.events, Date.now())
    try {
      // Validate before anything is written, so a malformed package fails with
      // no residue: the alternative is a stored session the reader cannot open
      // and cannot remove from the list.
      materializeCreateHeader(header)
      validateStoredEvents(header, events as never)
      const batch = materializeAppendBatch(events as never)
      // The one point where cancelling leaves nothing behind. `create` alone
      // does not materialize on the JSONL backend, so closing it writes no file;
      // once `append` resolves the log is durable and there is no delete in the
      // persistence contract to take it back.
      if (signal.aborted) return undefined

      const handle = await ctx.sessionPersistence.create(header, { signal })
      try {
        // The signal reaches the write itself, so a cancel that lands during
        // the append is refused by the backend rather than ignored here.
        if (batch.length > 0) await handle.append(batch, { signal })
        // The durability barrier: until it resolves the session may exist only
        // in this process's view of the backend, and a restart would lose the
        // conversation the reader just accepted.
        await handle.flush()
      } finally {
        await handle.close()
      }
      // The copy is stored, and that alone does not put it in a Workspace.
      // Membership is an explicit registry list, not a fact derived from the
      // header: the sidebar's groups are built from each Workspace's
      // `sessionIds`, so a session whose header names the directory but which
      // nobody attached lands in the ungrouped section. `attachSession`
      // revalidates the header against the Workspace's own path and records
      // the id, which is what a session created here would have gone through.
      await attachToWorkspace(ctx, id, cwd, log)
      return id
    } catch (error) {
      log.warn(`import failed: ${String(error)}`)
      return undefined
    }
  }

  ctx.effect(() => ctx.connection.fetch.register({
    path: SHARE_ROUTE,
    methods: ['POST'],
    requestBody: 'buffered',
    fetch: async (request: Request): Promise<Response> => {
      const answer = await handle(request, config, readSession, importPackage)
      return Response.json(answer)
    },
  }), 'aishell-share: share route')
}

/**
 * Dispatch one Page request.
 *
 * @param request - the incoming request.
 * @param config - resolved plugin config.
 * @param readSession - reads a package from this machine's store.
 * @param importPackage - rebuilds a package as a session here.
 * @returns what the Page receives.
 */
async function handle(
  request: Request,
  config: Config,
  readSession: (sessionId: string, messageId?: string) => Promise<SharePackage | undefined>,
  importPackage: (pkg: SharePackage, cwd: string, signal: AbortSignal) => Promise<string | undefined>,
): Promise<ShareResponse> {
  const body = await request.json().catch(() => undefined) as ShareRequest | undefined
  if (body === undefined) return { ok: false, reason: 'bad-request' }

  if (body.op === 'share') {
    const pkg = await readSession(body.sessionId, body.messageId)
    if (pkg === undefined) return { ok: false, reason: 'bad-request' }
    const created = await createShare(config.serviceOrigin, JSON.stringify(pkg), request.signal)
    return created.ok ? { ok: true, url: created.value.url } : { ok: false, reason: created.reason }
  }

  if (body.op === 'fetch') {
    const body_ = await readShare(config.serviceOrigin, body.id, request.signal)
    if (!body_.ok) return { ok: false, reason: body_.reason }
    const pkg = parsePackage(body_.value)
    return pkg === undefined ? { ok: false, reason: 'rejected' } : { ok: true, session: pkg }
  }

  if (body.op === 'import') {
    // A directory is required and checked here rather than assumed: the copy
    // is filed under it, so an empty or relative one would create a session
    // the sidebar cannot place.
    if (typeof body.cwd !== 'string' || !isAbsolute(body.cwd)) {
      return { ok: false, reason: 'bad-request' }
    }
    // Re-validated even though `fetch` already did it: this request crossed a
    // process boundary, and the body is whatever the Page sent.
    const pkg = readPackage(body.session)
    if (pkg === undefined) return { ok: false, reason: 'bad-request' }
    const sessionId = await importPackage(pkg, body.cwd, request.signal)
    return sessionId === undefined ? { ok: false, reason: 'rejected' } : { ok: true, sessionId }
  }

  return { ok: false, reason: 'bad-request' }
}

/**
 * Parse a response body into a package.
 *
 * @param text - the raw body the service returned.
 * @returns the package, or undefined when the body is not one.
 */
function parsePackage(text: string): SharePackage | undefined {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    return undefined
  }
  return readPackage(value)
}

/**
 * Mint an id for a locally created session.
 *
 * @returns a unique id, shaped like the ones the session store mints.
 */
function mintSessionId(): string {
  return crypto.randomUUID()
}

export { SESSION_KIND, SHARE_ROUTE as ROUTE }