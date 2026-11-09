/**
 * The connection to the sandbox gateway.
 *
 * One `Sandbox` handle is built per sandbox id and reused, because the SDK's
 * instance holds the resolved endpoints and per-sandbox tokens that the create
 * response supplied. Rebuilding one per call would mean either reconnecting
 * (an extra control-plane round trip) or, worse, constructing a handle from
 * just an id — which works but silently drops the tokens the sandbox was
 * actually issued, turning an authentication problem into "port is not open".
 *
 * ## What the SDK is configured with
 *
 * `domain` alone. The SDK composes `https://api.<domain>` for the control
 * plane and `https://<port>-<sandboxId>.<domain>` for the data plane, and
 * reads the key from `apiKey`. That is the whole configuration, which is the
 * point of the gateway: a stock E2B client reaches it with two settings and no
 * patched code.
 *
 * @module @huaweidevtools/aishell-dsh-e2b/client
 */

import { Sandbox } from 'e2b'

import type { SandboxKeySource } from './sandbox-key.ts'

/**
 * How many pages of a list response to follow before giving up.
 *
 * Bounds one listing at 1000 sandboxes. A filter that matches nothing would
 * otherwise walk an entire account one page at a time; no deployment this
 * plugin is used against should reach the cap.
 */
const MAX_LIST_PAGES = 10

/**
 * The template to start from when the caller names none.
 *
 * Not the SDK's own default. The SDK resolves an omitted template to `"base"`,
 * a name from the hosted service; this gateway's templates are its own, and it
 * answers `"base"` with `404 sandbox unknown was not found` — a message that
 * reads like a missing sandbox rather than an unknown template, which is what
 * makes it worth pinning here rather than discovering at the first create.
 *
 * `"default"` is what this gateway provisions.
 */
export const DEFAULT_TEMPLATE = 'default'

/** How the connection is parameterised; every field is read per call. */
export interface SandboxClientOptions {
  /** The gateway's domain, e.g. `aishell.openbuildlab.com`. */
  readonly resolveDomain: () => string
  /** The key source, which caches and refreshes the API key. */
  readonly keys: SandboxKeySource
  /** Per-request timeout for SDK control-plane calls. */
  readonly resolveRequestTimeoutMs: () => number
}

/** Builds and caches SDK handles, one per sandbox id. */
export class SandboxClient {
  private readonly options: SandboxClientOptions
  /** Sandbox id → the live handle for it. */
  private readonly handles = new Map<string, Sandbox>()

  constructor(options: SandboxClientOptions) {
    this.options = options
  }

  /**
   * The live handle for one sandbox.
   *
   * @param sandboxId - the sandbox to address.
   * @returns the cached handle, or a newly connected one.
   */
  async handle(sandboxId: string): Promise<Sandbox> {
    const cached = this.handles.get(sandboxId)
    if (cached !== undefined) return cached
    const connected = await this.connect(sandboxId)
    this.handles.set(sandboxId, connected)
    return connected
  }

  /**
   * Create a sandbox and cache its handle.
   *
   * @param template - the template name or id; {@link DEFAULT_TEMPLATE} when
   *   omitted.
   * @param options - create options forwarded to the SDK.
   * @returns the created sandbox handle.
   */
  async create(template: string | undefined, options: {
    readonly timeoutMs?: number
    readonly envs?: Record<string, string>
    readonly metadata?: Record<string, string>
    readonly signal?: AbortSignal
  }): Promise<Sandbox> {
    const common = {
      domain: this.options.resolveDomain(),
      requestTimeoutMs: this.options.resolveRequestTimeoutMs(),
      ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
      ...(options.envs === undefined ? {} : { envs: options.envs }),
      ...(options.metadata === undefined ? {} : { metadata: options.metadata }),
    }
    // Two overloads, not one with an optional argument: the SDK declares
    // `create(opts)` and `create(template, opts)` separately, so the template
    // has to be branched on rather than spread.
    // Always named: passing no template lets the SDK fall back to its own
    // `"base"`, which this gateway does not have. See {@link DEFAULT_TEMPLATE}.
    const resolved = template ?? DEFAULT_TEMPLATE
    const sandbox = await this.runWithKeyRefresh(options.signal, (apiKey, signal) => (
      Sandbox.create(resolved, { ...common, apiKey, ...(signal === undefined ? {} : { signal }) })
    ))
    this.handles.set(sandbox.sandboxId, sandbox)
    return sandbox
  }

  /**
   * Walk the sandbox listing, following the pagination cursor.
   *
   * ## Why it follows the cursor
   *
   * The gateway pages at 100 and reports more with a cursor. A single page is
   * enough for the common case and wrong for a busy account — and wrong in the
   * direction that matters: the caller is told "these are all of them" when
   * they are the first hundred, and a metadata search for one specific sandbox
   * reports "none" because that sandbox happens to be on a later page.
   *
   * ## Why the bound and the sequential awaits
   *
   * `MAX_LIST_PAGES` caps a filter that matches nothing, which would otherwise
   * walk the whole account one page at a time. The awaits are sequential by
   * necessity: each page's cursor comes from the previous response, so the
   * pages cannot be requested together.
   *
   * Shared by both listing calls so the two cannot drift in either respect.
   *
   * @param apiKey - the key to present.
   * @param query - the SDK query, when one narrows the listing.
   * @returns every row the walk collected.
   */
  private async collectPages(
    apiKey: string,
    query: { readonly query?: { readonly metadata: Record<string, string> } },
  ): Promise<Awaited<ReturnType<ReturnType<typeof Sandbox.list>['nextItems']>>> {
    const paginator = Sandbox.list({
      apiKey,
      domain: this.options.resolveDomain(),
      requestTimeoutMs: this.options.resolveRequestTimeoutMs(),
      ...query,
    })
    const collected: Awaited<ReturnType<typeof paginator.nextItems>> = []
    for (let page = 0; page < MAX_LIST_PAGES && paginator.hasNext; page += 1) {
      collected.push(...await paginator.nextItems())
    }
    return collected
  }

  /**
   * Find the sandboxes carrying one metadata pair.
   *
   * The SDK encodes the pair into the `metadata` query parameter and the
   * gateway forwards it to the upstream unchanged, so this is the mechanism a
   * restarted process uses to rediscover the sandbox a conversation was
   * working in.
   *
   * The search follows the pagination cursor. A single page would be enough
   * for the common case, but not for a busy account: the gateway pages at 100
   * and reports more with a cursor, and a conversation's own sandbox is not
   * ordered ahead of the others — so on the day an account holds more than a
   * page, the one sandbox the caller is looking for is as likely as any to be
   * on a later page, and a single-page search would report "none".
   *
   * @param metadata - the pair to match; a sandbox must carry all of it.
   * @param signal - caller cancellation.
   * @returns one row per matching sandbox.
   */
  async findByMetadata(
    metadata: Record<string, string>,
    signal: AbortSignal | undefined,
  ): Promise<Array<{ sandboxId: string, state: string }>> {
    const items = await this.runWithKeyRefresh(signal, apiKey => this.collectPages(apiKey, { query: { metadata } }))
    return items.map(item => ({ sandboxId: item.sandboxId, state: item.state }))
  }

  /**
   * List the sandboxes this account currently has.
   *
   * Follows the pagination cursor, for the same reason the metadata search
   * does: the gateway pages at 100, and a caller asking what it has should not
   * be told "these are all of them" when they are the first hundred.
   *
   * @param signal - caller cancellation.
   * @returns one row per sandbox, in the shape the tool renders.
   */
  async list(signal: AbortSignal | undefined): Promise<Array<{
    sandboxId: string
    templateId: string
    state: string
    startedAt: string
    endAt: string
  }>> {
    const items = await this.runWithKeyRefresh(signal, apiKey => this.collectPages(apiKey, {}))
    return items.map(item => ({
      sandboxId: item.sandboxId,
      templateId: item.templateId,
      state: item.state,
      startedAt: item.startedAt.toISOString(),
      endAt: item.endAt.toISOString(),
    }))
  }

  /**
   * Drop a handle for a sandbox that no longer exists.
   *
   * Called after a kill, so a later call against the same id re-resolves
   * rather than reusing an endpoint the gateway has already torn down.
   *
   * @param sandboxId - the sandbox whose handle to drop.
   */
  forget(sandboxId: string): void {
    this.handles.delete(sandboxId)
  }

  /** Connect to an existing sandbox. */
  private async connect(sandboxId: string): Promise<Sandbox> {
    const domain = this.options.resolveDomain()
    const requestTimeoutMs = this.options.resolveRequestTimeoutMs()
    return this.runWithKeyRefresh(undefined, (apiKey, signal) => Sandbox.connect(sandboxId, {
      apiKey,
      domain,
      requestTimeoutMs,
      ...(signal === undefined ? {} : { signal }),
    }))
  }

  /**
   * Run one SDK call, retrying once against a freshly fetched key when the
   * gateway rejects the one in hand.
   *
   * The key is handed to the callback rather than captured by it. A callback
   * that closed over the first key would "retry" by presenting that same
   * rejected key again — a loop that looks like a refresh and is not one.
   *
   * The retry is deliberately narrow: only an authentication failure clears
   * the cache, and only once. A key that fails for any other reason — a
   * sandbox that does not exist, a rate limit — is not evidence about the key,
   * and refreshing on it would rotate the tenant for no reason.
   */
  private async runWithKeyRefresh<T>(
    signal: AbortSignal | undefined,
    run: (apiKey: string, signal: AbortSignal | undefined) => Promise<T>,
  ): Promise<T> {
    const apiKey = await this.options.keys.get(signal)
    try {
      return await run(apiKey, signal)
    } catch (error) {
      if (!isAuthenticationFailure(error)) throw error
      // `invalidate` removes the stored key, so the next `get` necessarily
      // issues a different one — there is no "same key came back" case to
      // guard, and a second refusal is reported rather than retried again.
      this.options.keys.invalidate()
      const replacement = await this.options.keys.get(signal)
      return run(replacement, signal)
    }
  }
}

/**
 * Whether an error is the gateway refusing the credential.
 *
 * The SDK's `AuthenticationError` does not extend `SandboxError`, so a check
 * for `SandboxError` alone would miss exactly this case — which is the case
 * that has a remedy.
 */
function isAuthenticationFailure(error: unknown): boolean {
  if (error === null || typeof error !== 'object') return false
  return error.constructor?.name === 'AuthenticationError'
}