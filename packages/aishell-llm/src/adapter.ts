/**
 * aishell LLM gateway adapter for DSH.
 *
 * Routes model calls through the aishell gateway using direct AK/SK signing
 * (SDK-HMAC-SHA256). Every request — chat and model listing alike — is signed
 * with the user's AK/SK read from the credential store, so there is no API-key
 * exchange and no separate config fetch between the credential and the call.
 *
 * @module @huaweidevtools/aishell-dsh-llm/adapter
 */

import {
  LlmAdapter,
  LlmError,
  resolveImageAttachmentAccess,
  resolveRetryPolicy,
} from '@deepseek-ai/dsh-llm'
import type {
  GenerateOptions,
  LlmModelInfo,
  LlmProviderInfo,
  LlmReasoningEffortInfo,
  LlmResolvedModelInfo,
  ModelModality,
  ResolvedRetryPolicy,
  StreamChunk,
} from '@deepseek-ai/dsh-llm'
import type { AttachmentStore } from '@deepseek-ai/dsh-attachment'
import type { CredentialsStore } from '@huaweidevtools/aishell-dsh-credentials-store'
import { serializeRequest } from './serialize.ts'
import { translate } from './translate.ts'
import { parseSse } from './sse.ts'
import {
  assertImageRoles,
  assertRequestImageBudget,
  historyHasImage,
  prepareRequestImages,
  projectOffloaded,
  type ImageAccessResolver,
  type ImageRequestBudget,
} from './images.ts'
import { type SignCredentials, sign } from '@huaweidevtools/aishell-dsh-credentials-store/signer'
import { readStoredPair } from '@huaweidevtools/aishell-dsh-credentials-store/accounts'
import { PROVIDER_DISPLAY_NAME } from './provider-name.ts'
import type { WireModel, WireModelList } from './types.ts'

/**
 * Retries after the first attempt.
 *
 * Five, so a request is tried six times at most. Six requests is the point
 * where a rate limit that has not cleared is more likely to be a quota than a
 * burst, and the last delay alone is sixteen seconds.
 */
const RETRY_MAX_ATTEMPTS = 5

/**
 * First backoff delay. The ladder is this value doubled per attempt — 1, 2, 4,
 * 8, 16 seconds — so the cap below is what fixes the last rung.
 */
const RETRY_INITIAL_DELAY_MS = 1_000

/** Cap on one delay. Equal to the fifth rung, so the ladder is exact. */
const RETRY_MAX_DELAY_MS = 16_000

/**
 * Failures worth another attempt.
 *
 * Transient by definition: a rate limit asks for a later attempt, a server
 * error and a timeout say nothing about the request, and `EMPTY_RESPONSE` is
 * documented as safe to repeat because the attempt left nothing durable.
 *
 * Absent on purpose: `PROVIDER_ERROR` (a 4xx that is not a rate limit is a
 * statement about the request — a bad model id, a malformed body — and
 * repeating it returns the same answer), and `MISSING_CREDENTIAL` /
 * `INVALID_CREDENTIAL` (a retry cannot conjure a credential).
 */
const RETRYABLE_CODES = ['RATE_LIMIT', 'SERVER', 'TIMEOUT', 'TRANSPORT', 'EMPTY_RESPONSE'] as const

/** Adapter construction options. */
export interface GatewayAdapterOptions {
  /**
   * Resolve the current chat API base URL (e.g. `https://openai.aishell.openbuildlab.com/v1`).
   *
   * A reader, not a value, because this plugin's whole Config is `Volatile`: a
   * settings edit is a volatile-only update that commits into the existing
   * references and returns without re-running `apply()`
   * (`cordis-plugin-loader/lib/index.js:381-388`). The adapter instance
   * therefore outlives the values it was built with, and a captured string
   * would leave the settings surface showing the new endpoint while requests
   * kept going to the endpoint from construction — silently, for the life of
   * the process.
   */
  readonly resolveBaseUrl: () => string
  /** Credential store for reading AK/SK. */
  readonly keyring: CredentialsStore
  /**
   * Resolve the mounted attachment service, when the deployment has one.
   *
   * Resolved per request rather than captured at construction: the service is
   * provided by a sibling plugin whose fiber may mount after this one, and a
   * captured `undefined` would disable image input for the whole session.
   */
  readonly resolveAttachments?: () => AttachmentStore | undefined
  /** Mounted filesystem provider, mapped into the tool execution world for image handle paths. */
  readonly resolveHostPath?: (hostPath: string) => string | undefined
  /**
   * Resolve the per-image projection policy, read per request so a budget edit
   * takes effect without a reload — same reasoning as `resolveBaseUrl`.
   */
  readonly resolveImageBudget: () => ImageRequestBudget
  /** Resolve accumulated represented base64 bytes one request may carry before images must be offloaded. */
  readonly resolveMaxRequestImageBytes: () => number
}

/**
 * Whether a gateway error body reports an id the gateway does not carry.
 *
 * Both fields are accepted because the gateway emits them from one definition
 * and either proves the same fact; a proxy that strips one should not disable
 * the diagnosis. A body that is not the gateway's JSON is not a match.
 *
 * @param text - the error response body, as received.
 * @returns whether this is the "model not configured on this gateway" answer.
 */
function isModelNotFound(text: string): boolean {
  let body: unknown
  try {
    body = JSON.parse(text)
  } catch {
    return false
  }
  if (typeof body !== 'object' || body === null) return false
  const envelope = body as { error_code?: unknown, error?: unknown }
  if (envelope.error_code === 'AISHELL.1004') return true
  const inner = envelope.error
  return typeof inner === 'object' && inner !== null
    && (inner as { code?: unknown }).code === 'model_not_found'
}

/**
 * Map an HTTP status onto the harness's retryable failure vocabulary.
 *
 * ## Why this matters
 *
 * `resolveRetryPolicy` decides whether to retry from the **error code**, not
 * from the status. An adapter that reports every non-2xx as one undifferentiated
 * code makes the retry policy blind: a 429 and a 401 would look identical, so
 * either every failure retries or none does.
 *
 * ## The mapping
 *
 *   - `429` — `RATE_LIMIT`. The one case where the gateway is explicitly
 *     asking for a later attempt.
 *   - `5xx` — `SERVER`. A transient upstream fault; the same request may
 *     succeed.
 *   - `408` — `TIMEOUT`. The gateway timed out waiting; nothing about the
 *     request is wrong.
 *   - everything else — `PROVIDER_ERROR`. A 4xx that is not a rate limit is a
 *     statement about the request itself (a bad model id, a malformed body, a
 *     rejected credential), and repeating it produces the same answer.
 *
 * `PROVIDER_ERROR` is not in the default retryable set, which is exactly the
 * intent: refusing to retry a request the provider already said was wrong.
 *
 * @param status - the HTTP status of the rejected request.
 * @returns the code to carry on the `LlmError`.
 */
function classifyHttpFailure(status: number): string {
  if (status === 429) return 'RATE_LIMIT'
  if (status === 408) return 'TIMEOUT'
  if (status >= 500 && status <= 599) return 'SERVER'
  return 'PROVIDER_ERROR'
}

/**
 * Map the gateway's `modalities` array (e.g. `["text","image"]`) to DSH's
 * `ModelModality` vocabulary. DSH currently defines only `'text' | 'image'`;
 * other modalities (audio, video) are dropped — the gateway still accepts
 * them, but the harness catalog cannot advertise them.
 */
function mapModalities(modalities: readonly string[] | undefined): { inputModalities: readonly ModelModality[] } | Record<string, never> {
  if (modalities === undefined || modalities.length === 0) return {}
  const mapped = modalities.filter((m): m is ModelModality => m === 'text' || m === 'image')
  return mapped.length > 0 ? { inputModalities: mapped } : {}
}

export class GatewayAdapter extends LlmAdapter {
  /** Cached /models response (TTL-bounded so credential changes eventually refresh). */
  private modelsCache: { promise: Promise<readonly WireModel[]>; expires: number } | undefined
  private static readonly MODELS_TTL_MS = 60_000

  constructor(private readonly opts: GatewayAdapterOptions) {
    super()
  }

  override providerInfo(provider: string): LlmProviderInfo {
    // The same literal the Models row is registered with, imported rather
    // than repeated: the picker and that row name one route, and two copies
    // of the string is how they drift apart.
    return { id: provider, name: PROVIDER_DISPLAY_NAME }
  }

  /**
   * The retry policy this route runs under.
   *
   * ## Why the adapter owns it
   *
   * The executor (`@deepseek-ai/dsh-llm-retry`, mounted by `dsh-base`) retries
   * whatever a provider's policy says to retry, and it reads the policy from
   * the provider registration. Declaring it here is what lets a 429 on this
   * gateway be retried without retrying a 401 — the previous code reported
   * every non-2xx as `PROVIDER_ERROR`, which put nothing in the retryable set
   * and so retried nothing.
   *
   * ## The shape
   *
   * Five retries after the first attempt, so six requests at most. Delays are
   * 1, 2, 4, 8 and 16 seconds: `localDelay` computes
   * `initialDelayMs * 2 ** (retry - 1)` capped at `maxDelayMs`, so the caps and
   * the initial delay together spell that exact ladder.
   *
   * `jitterRatio: 0` is deliberate. Jitter exists to spread a fleet's retries
   * off one another; this adapter has one client per user, and the countdown
   * the chat UI renders is the scheduled delay — jitter would make it disagree
   * with the number the user is told.
   *
   * Eligible codes are the transient ones. `PROVIDER_ERROR` is deliberately
   * absent: a 4xx that is not a rate limit is a statement about the request,
   * and repeating it produces the same answer. `EMPTY_RESPONSE` is included
   * because the harness documents it as safe to repeat — the attempt produced
   * nothing durable.
   */
  override providerRetryPolicy(_provider: string): ResolvedRetryPolicy {
    return resolveRetryPolicy({
      mode: 'normal',
      maxRetries: RETRY_MAX_ATTEMPTS,
      retryableCodes: [...RETRYABLE_CODES],
      backoff: {
        initialDelayMs: RETRY_INITIAL_DELAY_MS,
        maxDelayMs: RETRY_MAX_DELAY_MS,
        jitterRatio: 0,
      },
    }, 'aishell-llm: retry policy')
  }

  /**
   * Fetch the raw wire models from `/models`, cached for a short TTL so
   * `listModels` and `resolveModel` don't each sign a separate request.
   * Returns `[]` on any failure (missing credentials, network, non-ok) so
   * the provider still registers — the user can type a model ID manually.
   */
  private async fetchWireModels(): Promise<readonly WireModel[]> {
    const now = Date.now()
    if (this.modelsCache !== undefined && this.modelsCache.expires > now) {
      return this.modelsCache.promise
    }
    // No credentials yet — return empty WITHOUT caching, so the next call
    // (after the user saves credentials) re-fetches instead of reading a
    // cached empty list for the full TTL.
    if (!this.hasCredentials()) return []
    const promise = (async () => {
      const response = await this.signedFetch('/models', 'GET', undefined, undefined)
      if (!response.ok) return []
      const json = await response.json() as WireModelList
      return json.data ?? []
    })().catch(() => [] as readonly WireModel[])
    this.modelsCache = { promise, expires: now + GatewayAdapter.MODELS_TTL_MS }
    return promise
  }

  override async listModels(provider: string): Promise<readonly LlmModelInfo[]> {
    const wireModels = await this.fetchWireModels()
    return wireModels.map(m => ({
      provider,
      id: m.id,
      // `name ?? id`, the same preference the official adapters carry
      // (`dsh-llm-deepseek`: `name: model.name ?? model.id`). The two fields
      // answer different questions: `id` is the routing key a request must
      // carry and the gateway must keep stable, while `name` is only ever
      // rendered. An id chosen to be durable — a reserved alias like
      // `trial` — is not necessarily pleasant to read, and this is what
      // lets the label be pleasant anyway.
      name: m.name ?? m.id,
      ...mapModalities(m.modalities),
    }))
  }

  override async resolveModel(
    provider: string,
    model: string,
  ): Promise<LlmResolvedModelInfo> {
    const wireModels = await this.fetchWireModels()
    const wire = wireModels.find(m => m.id === model)
    const base = {
      provider,
      id: model,
      // Same preference as `listModels`, and for the same reason. A model
      // absent from the catalog has no wire name to read; the id stands in
      // until the request itself is rejected.
      name: wire?.name ?? model,
      ...mapModalities(wire?.modalities),
    }
    if (wire === undefined) return base

    const contextWindow = wire.limits?.context_window
    const maxCompletion = wire.limits?.max_completion_tokens
    const efforts = wire.reasoning_effort

    return {
      ...base,
      ...(typeof contextWindow === 'number' && contextWindow > 0
        ? { context: { contextWindow } }
        : {}),
      ...(typeof maxCompletion === 'number' && maxCompletion > 0
        ? { defaultMaxTokens: maxCompletion }
        : {}),
      ...(Array.isArray(efforts) && efforts.length > 0
        ? { reasoning: { efforts: efforts.map(e => ({ id: e, name: e }) as LlmReasoningEffortInfo) } }
        : {}),
    }
  }

  /**
   * Whether a usable AK/SK pair is stored.
   *
   * The one predicate behind every "can this route do anything" question:
   * `fetchWireModels` returns an empty catalog without it, and the Models-page
   * card reports readiness from it. Kept in one place so the catalog and the
   * card cannot disagree about whether this route is usable.
   *
   * @returns whether both halves of the signing credential are present.
   */
  hasCredentials(): boolean {
    return this.readCredentials() !== undefined
  }

  /**
   * Read the AK/SK pair from the credential store.
   *
   * Delegates to the shared reader: this adapter, `aishell-e2b`,
   * `aishell-credentials` and `aishell-deploy` all read the same record, and a
   * local copy of that rule is how two of them end up disagreeing about what
   * "credentials are configured" means.
   *
   * Read per request, never captured — that is what makes a rotation in the
   * credential form apply to the very next call.
   */
  private readCredentials(): SignCredentials | undefined {
    return readStoredPair(this.opts.keyring)
  }

  /**
   * Read credentials or throw `MISSING_CREDENTIAL` — every signing code path
   * goes through here.
   */
  private requireCredentials(): SignCredentials {
    const creds = this.readCredentials()
    if (!creds) {
      throw new LlmError(
        'aishell-llm: not authenticated with Huawei Cloud IAM',
        'MISSING_CREDENTIAL',
      )
    }
    return creds
  }

  /**
   * Sign a request with AK/SK and fetch. Encapsulates the SDK-HMAC-SHA256
   * signing flow: read credentials → sign → attach headers → fetch.
   */
  private async signedFetch(
    path: string,
    method: 'GET' | 'POST',
    body: string | undefined,
    signal?: AbortSignal,
  ): Promise<Response> {
    const creds = this.requireCredentials()
    // Sign the path the request actually carries, not the relative one handed
    // in. The signature covers the canonical URI (`signer.ts` builds it from
    // this argument), so a `baseUrl` with its own path segment — `/v1`, which
    // the default now has — would otherwise be signed as `/models` while being
    // requested as `/v1/models`, and the gateway would reject it.
    const requestUrl = new URL(`${this.opts.resolveBaseUrl()}${path}`)
    const headers = sign(method, requestUrl.host, requestUrl.pathname, {}, body ?? '', creds)
    return fetch(requestUrl, {
      method,
      headers: {
        host: headers.host,
        'x-sdk-date': headers['x-sdk-date'],
        Authorization: headers.Authorization,
        ...(headers['x-security-token'] !== undefined
          ? { 'x-security-token': headers['x-security-token'] }
          : {}),
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      },
      ...(body !== undefined ? { body } : {}),
      ...(signal ? { signal } : {}),
    })
  }

  /**
   * Diagnose an "unsupported model" rejection and append what to do about it.
   *
   * The gateway answers a model id it does not carry with `AISHELL.1004`
   * (`model_not_found`, HTTP 404 — see {@link isModelNotFound}). The default
   * selection is a pinned literal (it must be readable before any credential or
   * network call could enumerate the catalog), so the day the catalog drops
   * that id, every fresh session fails here. Rather than leave the user to
   * reverse-engineer the supported set, the failure itself asks the gateway
   * (the catalog cache usually makes this a second signed GET already in
   * flight) and names the models it currently accepts.
   *
   * Returns '' for any other failure, so the message stays untouched there.
   */
  private async unsupportedModelHint(text: string, options: GenerateOptions): Promise<string> {
    if (!isModelNotFound(text)) return ''
    const ids = (await this.fetchWireModels().catch(() => []) as readonly WireModel[])
      .map(m => m.id)
      .filter(id => id.length > 0)
    if (ids.length === 0) return ''
    return ` (this gateway currently supports: ${ids.join(', ')}; switch the model in the picker`
      + ` — the switch also becomes your saved default. Requested: ${options.model})`
  }

  /**
   * Resolve one image occurrence's execution-world read path, when the
   * deployment exposes one. Only enriches the handle text written beside an
   * image; a deployment without a filesystem provider simply yields the
   * shorter form.
   *
   * Deliberately unguarded, like the official adapters: this throws only for
   * an invalid durable reference, and every reference reaching here was
   * already validated by the `readImageRequest` that loaded its bytes — so a
   * throw means the attachment record is inconsistent, which should surface
   * rather than be absorbed into less informative handle text.
   */
  private readonly imageAccess: ImageAccessResolver = (ref) => {
    const attachments = this.opts.resolveAttachments?.()
    if (attachments === undefined) return undefined
    return resolveImageAttachmentAccess(
      attachments,
      hostPath => this.opts.resolveHostPath?.(hostPath),
      ref,
    )
  }

  /**
   * Turn the harness history into the wire body, loading image bytes on the
   * way.
   *
   * Deliberately the whole image pipeline and nothing else, so `stream` stays
   * about transport. The ordering is load-bearing and matches the official
   * adapters: resolve the attachment service, prepare one request version per
   * retained image, fail the request when the budget is exceeded (handing
   * `dsh-compaction-image-offload` its decision), and only then project the
   * offloaded occurrences to placeholder text. That projection has to come
   * last: an offloaded occurrence is one an earlier request decided not to
   * send, so serialization replaces it with text rather than looking up bytes
   * that were deliberately never loaded.
   */
  private async buildBody(options: GenerateOptions): Promise<string> {
    if (!historyHasImage(options.messages)) {
      return JSON.stringify(serializeRequest(options, undefined, this.imageAccess))
    }
    assertImageRoles(options.messages)
    const attachments = this.opts.resolveAttachments?.()
    if (attachments === undefined) {
      throw new LlmError(
        'aishell-llm image input requires the durable attachment service',
        'UNSUPPORTED_CONTENT',
      )
    }
    const messages = options.messages
    const images = await prepareRequestImages(messages, attachments, this.opts.resolveImageBudget(), options.signal)
    assertRequestImageBudget(messages, images, this.opts.resolveMaxRequestImageBytes())
    // `projectOffloaded` answers a readonly list (it copies rather than
    // mutating the frozen request); `GenerateOptions.messages` is mutable, so
    // the copies are collected back into a fresh array.
    const projected = [...projectOffloaded(messages, this.imageAccess)]
    return JSON.stringify(serializeRequest(
      { ...options, messages: projected },
      images,
      this.imageAccess,
    ))
  }

  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    // Built ahead of the transport try, deliberately: every failure this can
    // raise is already classified (image budget, unprepared reference, missing
    // attachment service) or belongs to the attachment backend that raised it,
    // and none of them is a network failure. Routing them through the transport
    // catch below would dress a storage error as `TRANSPORT` — retried, and
    // retrying cannot fix it — and would strand the offload recovery listener,
    // which keys on the code it was given. A throw here still reaches that
    // listener: the runtime wraps `iterator.next()` — where a generator body
    // starts — in its own try and turns the throw into a terminal failure chunk.
    const body = await this.buildBody(options)

    let response: Response
    try {
      response = await this.signedFetch('/chat/completions', 'POST', body, options.signal)
    } catch (error: unknown) {
      if (options.signal?.aborted) throw error
      // `signedFetch` can fail before any transport work: without a stored
      // AK/SK it raises `MISSING_CREDENTIAL`, which is a configuration fact the
      // user can act on, not a transient network fault. Re-wrapping it would
      // hand every consumer the wrong class — and the message would nest the
      // original inside "request failed:". Anything that already carries a
      // code keeps it.
      if (error instanceof LlmError) throw error
      // `TRANSPORT` rather than a locally invented name: it is the code the
      // harness's retry policy lists for a failed round trip, and it is what
      // the shipped adapters raise for the same case. A private spelling would
      // make this route the one place a network fault is not retried.
      throw new LlmError(
        `aishell-llm: request failed: ${error instanceof Error ? error.message : String(error)}`,
        'TRANSPORT',
      )
    }

    if (!response.ok) {
      const text = await response.text().catch(() => '')
      throw new LlmError(
        `aishell-llm: gateway returned ${response.status}: ${text}`
        + await this.unsupportedModelHint(text, options),
        classifyHttpFailure(response.status),
        { status: response.status },
      )
    }

    if (!response.body) {
      throw new LlmError('aishell-llm: gateway returned no body', 'EMPTY_RESPONSE')
    }

    yield* translate(parseSse(response.body))
  }
}
