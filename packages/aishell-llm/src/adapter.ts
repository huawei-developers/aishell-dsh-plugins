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
  BuiltinLlmFailureCode,
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
 * Absent on purpose: the unclassified 4xx codes (`` `HTTP_${status}` `` — a 4xx
 * that is not a rate limit is a statement about the request, a bad model id or
 * a malformed body, and repeating it returns the same answer), and
 * `MISSING_CREDENTIAL` / `INVALID_CREDENTIAL` (a retry cannot conjure a
 * credential).
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
  /**
   * Report that the advertised model catalog changed.
   *
   * The harness forwards `llm/models-updated(provider)` to the browser, and
   * every open model picker refetches on it — a model the gateway adds, retires,
   * or re-costs reaches the selector without a page reload. The adapter cannot
   * emit that event itself: it holds no context, by design, so the plugin that
   * owns it supplies the notification.
   *
   * Called only when a CATALOG CHANGED, never on a first load: the first load is
   * what the caller was waiting for, so announcing it would only make that
   * caller reload what it already holds.
   *
   * Optional, and failures are contained: a notification is an observer of a
   * successful refresh and must not be able to fail one.
   */
  readonly onCatalogChanged?: () => void
  /**
   * Report a catalog entry the adapter cannot use.
   *
   * The gateway's contract says every model carries `limits.context_window`.
   * One that does not is a defect upstream, not a model this adapter should
   * quietly degrade: without a capacity, `compaction-basic` cannot price the
   * route and refuses a switch to it (`MODEL_SWITCH_COMPACTION_FAILED`). Saying
   * so once per offending id is what turns a confusing refusal into a fixable
   * report; staying silent would leave the user to infer it from the failure.
   *
   * Optional because the adapter holds no context of its own; the plugin that
   * owns it supplies its logger.
   */
  readonly warn?: (message: string) => void
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
 *   - everything else — `` `HTTP_${status}` ``. A 4xx that is not a rate limit
 *     is a statement about the request itself (a bad model id, a malformed
 *     body, a rejected credential), and repeating it produces the same answer.
 *
 * `` `HTTP_${status}` `` is the harness's own spelling for exactly this case —
 * `BuiltinLlmFailureCode` admits it alongside the named codes — and it is what
 * the shipped adapters raise for a non-2xx they cannot classify further. It is
 * not in the default retryable set, which is exactly the intent: refusing to
 * retry a request the provider already said was wrong. Naming the status rather
 * than folding every 4xx into one code keeps two different rejections apart in
 * a log.
 *
 * @param status - the HTTP status of the rejected request.
 * @returns the code to carry on the `LlmError`.
 */
function classifyHttpFailure(status: number): BuiltinLlmFailureCode {
  if (status === 429) return 'RATE_LIMIT'
  if (status === 408) return 'TIMEOUT'
  if (status >= 500 && status <= 599) return 'SERVER'
  return `HTTP_${status}`
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

/**
 * Share of the context window requested as output when the gateway declares no
 * cap of its own.
 *
 * The cap is also what compaction reserves: `compaction-basic` subtracts the
 * whole request cap from the window before it prices pressure, so the share
 * decides how much of the window is conversation. Ten percent at the
 * 131 072-token window most models carry is ~13k tokens of answer — around ten
 * thousand words — and leaves the pressure threshold at 40% of the window.
 * Larger shares trade conversation for output no answer uses: at thirty percent
 * the same window compacts at 20%.
 */
const DEFAULT_OUTPUT_WINDOW_SHARE = 0.1

/**
 * The output budget one request asks for.
 *
 * The gateway's `max_completion_tokens` when it declares one: that is the
 * upstream's own limit, so it is both accurate and as generous as the model is.
 * {@link DEFAULT_OUTPUT_WINDOW_SHARE} otherwise, since a listing that omits the
 * field still has to produce a request with a budget.
 *
 * ## The bound this function does and does not apply
 *
 * A cap cannot exceed the window. That is the whole of what this adapter can
 * establish from its own inputs, and it is unconditional: a request asking for
 * more output than the model holds cannot be served, whoever declared it.
 *
 * Whether the route can COMPACT is a different question and belongs to
 * `compaction-basic`, which owns `headroomTokens`, `thresholdRatio` and
 * `retainRatio` — the three settings that decide it, and the ones a deployment
 * overrides per model. Reproducing that arithmetic here would bind this file to
 * defaults it does not control, and miss in both directions: a lowered headroom
 * would leave this adapter rejecting routes the harness would have priced
 * happily, and a raised one would let it offer routes that fail on use. The
 * owner of those settings is the one that can answer, and it answers with a
 * message naming the model and the setting to change.
 *
 * @param contextWindow - the model's advertised window.
 * @param declared - the gateway's own completion cap, when it declares one.
 * @returns the output budget to request, or `undefined` when the window is not
 *   a usable capacity at all.
 */
function outputCapFor(contextWindow: number, declared: number | undefined): number | undefined {
  if (!Number.isInteger(contextWindow) || contextWindow <= 0) return undefined
  const wanted = typeof declared === 'number' && declared > 0
    ? declared
    : Math.floor(contextWindow * DEFAULT_OUTPUT_WINDOW_SHARE)
  return Math.max(1, Math.min(wanted, contextWindow))
}

/** Models to read when there is no catalog to read: one shared empty value. */
const NO_MODELS: readonly WireModel[] = []
/** The matching per-model index; see {@link ModelCatalogCache.known}. */
const NO_KNOWN: ReadonlyMap<string, WireModel> = new Map()

/**
 * One account's model catalog: what the gateway last advertised, plus the last
 * thing it said about every model it has ever advertised.
 *
 * ## Why the two records are separate
 *
 * `models` is the catalog a picker renders, and it is meant to shrink — that is
 * what a retired model does. What a model *is* outlives that: a Turn already
 * running against a model which just left the catalog still needs its context
 * window, because compaction prices against the capacity it holds and refuses a
 * switch to a target that has none
 * (`compaction-basic`: `MODEL_SWITCH_COMPACTION_FAILED`). `known` carries that
 * knowledge, and removal from `models` does not touch it.
 *
 * ## Why `checkedAt` counts failures
 *
 * It answers "when did we last ask", not "when did we last succeed". A gateway
 * that is down answers every request with the same refusal, and re-asking on
 * every step of every Turn would spend the request deadline each time. One
 * attempt per TTL — successful or not — is the budget.
 */
interface ModelCatalogCache {
  /** The access key this catalog was listed for; another account is another catalog. */
  readonly scope: string
  /** The last successfully advertised list. */
  models: readonly WireModel[]
  /** The latest entry seen for every model id, retained after it leaves {@link models}. */
  readonly known: Map<string, WireModel>
  /** Whether {@link models} came from a successful load. */
  loaded: boolean
  /** When the last attempt settled, successful or not; 0 before the first one. */
  checkedAt: number
  /** The load running for this scope, shared by every caller waiting on it. */
  inflight: Promise<void> | undefined
}

/** What one read of the catalog sees. */
interface CatalogSnapshot {
  /** The catalog to render. */
  readonly models: readonly WireModel[]
  /** Per-model metadata, including models a later catalog stopped listing. */
  readonly known: ReadonlyMap<string, WireModel>
}

/**
 * Wait for `settled` unless `signal` gives up first.
 *
 * The shared load keeps running: this abandons one caller's WAIT, not the
 * catalog another caller is waiting on. Cancelling a Turn must not also cancel
 * the listing a picker opened a moment ago is about to read.
 *
 * @param settled - the shared work.
 * @param signal - the caller's cancellation.
 */
async function abandonable(settled: Promise<void>, signal: AbortSignal | undefined): Promise<void> {
  if (signal === undefined) return settled
  signal.throwIfAborted()
  const abandoned = Promise.withResolvers<never>()
  const abandon = (): void => { abandoned.reject(signal.reason) }
  signal.addEventListener('abort', abandon, { once: true })
  try {
    await Promise.race([settled, abandoned.promise])
  } finally {
    signal.removeEventListener('abort', abandon)
  }
}

/**
 * Whether two catalogs say the same thing about the same models.
 *
 * Every field is compared, not just the ids: a rollout that changes a model's
 * context window or reasoning efforts is a change a picker has to reflect, and
 * comparing ids alone would report it as none. Order counts too — the gateway
 * order is the order the picker shows.
 *
 * @param left - the catalog in hand.
 * @param right - the catalog just loaded.
 * @returns whether a reader would see no difference.
 */
function sameCatalog(left: readonly WireModel[], right: readonly WireModel[]): boolean {
  if (left.length !== right.length) return false
  for (let index = 0; index < left.length; index += 1) {
    if (JSON.stringify(left[index]) !== JSON.stringify(right[index])) return false
  }
  return true
}

export class GatewayAdapter extends LlmAdapter {
  /** The current account's catalog; see {@link ModelCatalogCache}. */
  private modelsCache: ModelCatalogCache | undefined

  /**
   * Ids already reported as unusable, so the repair advice is said once.
   *
   * Bounded by the gateway's model count. Not cleared on an account rotation:
   * the defect is the model's, not the account's, and re-reporting it on every
   * switch would be the per-minute noise this exists to avoid.
   */
  private readonly reportedUnusable = new Set<string>()

  /**
   * How long a catalog is trusted before the next read refreshes it behind the
   * answer. A catalog is advisory: it names models and their capacities, and a
   * stale entry still routes a request correctly.
   */
  private static readonly MODELS_TTL_MS = 60_000

  /**
   * Deadline of one `/models` request.
   *
   * The listing hangs below the request that needs it, so an unbounded one
   * would hold every step of every Turn for as long as the gateway leaves the
   * connection open — and cancellation would not reach it, because the request
   * carries no other signal. Five seconds is the official adapter's own
   * listing deadline (`DEFAULT_MODELS_TIMEOUT_MS`).
   */
  private static readonly MODELS_TIMEOUT_MS = 5_000

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
   * gateway be retried without retrying a 401: the policy names specific
   * codes, so the classification below has to keep them apart.
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
   * Eligible codes are the transient ones. The unclassified 4xx codes are
   * deliberately absent: a 4xx that is not a rate limit is a statement about
   * the request, and repeating it produces the same answer. `EMPTY_RESPONSE`
   * is included because the harness documents it as safe to repeat — the
   * attempt produced nothing durable.
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
   * The catalog for the current account, refreshing it when it has gone stale.
   *
   * ## Why a stale catalog answers immediately
   *
   * `resolveModel` runs on the send path: `LlmRuntime.prepareCall` awaits it
   * before every request step. Waiting on a listing there makes one slow
   * `GET /models` into a stall on the user's message, which is the worst place
   * in the product to put a network round trip that is not the answer itself.
   * So only a COLD read waits (there is nothing to answer with); every later
   * read answers from memory and hands the refresh to the background.
   *
   * The trade is that an edited catalog reaches the current Turn one step late.
   * A capacity change is invisible there — compaction prices against a
   * threshold with headroom. A reasoning effort the server drops can cost one
   * `UNSUPPORTED_REASONING_EFFORT` before the refresh settles, and that failure
   * is what the refreshing prevents from recurring. Waiting on the read
   * instead would spend a stall on every user, on every stale read, to save
   * that one.
   *
   * ## Why a failed load keeps the previous catalog
   *
   * A gateway that is briefly unreachable, or that answers with an empty list
   * while a rollout lands, says nothing about which models exist. Such an
   * answer is not a catalog: honouring it would empty the picker and strip
   * every running Turn of its capacities. The official adapter draws the line
   * the same way, and harder — `parseModelListing` rejects a listing with no
   * entries outright — so an empty list here is the same kind of answer as a
   * 403, and the catalog in hand survives both.
   *
   * @param signal - abandons this caller's wait, never the shared load.
   * @returns the catalog to read, and the per-model memory beside it.
   */
  private async readCatalog(signal?: AbortSignal): Promise<CatalogSnapshot> {
    const scope = this.readCredentials()?.ak
    // No credentials yet — answer empty WITHOUT recording anything, so saving a
    // pair re-fetches immediately instead of reading an empty catalog for the
    // rest of the TTL. A previous account's catalog is dropped outright: it
    // describes models this account may not be offered.
    if (scope === undefined) {
      this.modelsCache = undefined
      return { models: NO_MODELS, known: NO_KNOWN }
    }

    const now = Date.now()
    let cache = this.modelsCache
    if (cache !== undefined && cache.scope !== scope) {
      // A rotation between accounts. The new account's catalog is unknown, not
      // stale, so this read waits for it — and the old account's index goes
      // with it, since it answers for models this account never advertised.
      cache = undefined
      this.modelsCache = undefined
    }
    if (cache === undefined) {
      const fresh: ModelCatalogCache = {
        scope,
        models: NO_MODELS,
        known: new Map(),
        loaded: false,
        checkedAt: 0,
        inflight: undefined,
      }
      this.modelsCache = fresh
      return this.awaitSnapshot(fresh, signal)
    }
    if (cache.checkedAt === 0) return this.awaitSnapshot(cache, signal)
    if (now - cache.checkedAt >= GatewayAdapter.MODELS_TTL_MS && cache.inflight === undefined) {
      // Stale: answer from memory and let the refresh land when it lands.
      void this.refresh(cache)
    }
    return { models: cache.models, known: cache.known }
  }

  /**
   * Await one load and read what it landed.
   *
   * A load settles rather than rejecting, so the only way this throws is the
   * caller's own abandonment — which is why the snapshot is read after the wait
   * and never before: a caller that walked away gets nothing, and one that
   * stayed gets whatever the load left behind.
   *
   * @param cache - the record to wait on and read from.
   * @param signal - abandons this caller's wait only.
   * @returns the catalog as of the load settling.
   */
  private async awaitSnapshot(cache: ModelCatalogCache, signal: AbortSignal | undefined): Promise<CatalogSnapshot> {
    await abandonable(this.refresh(cache), signal)
    return { models: cache.models, known: cache.known }
  }

  /**
   * Load the current account's catalog into `cache`, once at a time.
   *
   * @param cache - the record to write into. A rotation replaces the record, so
   *   a load that settles after one recognises itself as stale by identity and
   *   leaves the new account's record alone.
   * @returns the shared load, resolving whether or not the request succeeded.
   */
  private refresh(cache: ModelCatalogCache): Promise<void> {
    if (cache.inflight !== undefined) return cache.inflight
    const load = (async (): Promise<void> => {
      let models: readonly WireModel[] = NO_MODELS
      try {
        const response = await this.signedFetch(
          '/models', 'GET', undefined, AbortSignal.timeout(GatewayAdapter.MODELS_TIMEOUT_MS),
        )
        if (response.ok) {
          const json = await response.json() as WireModelList
          models = json.data ?? NO_MODELS
        }
      } catch {
        // Network, timeout, or an unreadable body: all mean "no answer", which
        // the previous catalog already survives.
      }
      // The record was replaced while this request was in flight — a rotation
      // or a clear — so the answer describes an account this adapter is not
      // serving. It is not written into the record that replaced it.
      if (this.modelsCache !== cache) return
      cache.checkedAt = Date.now()
      // Neither an empty answer nor a failed one is a catalog: both leave
      // `models` empty here, and the catalog in hand survives both.
      if (models.length === 0) return
      // Applies after the empty-answer guard above, so a listing whose every
      // entry is malformed is still treated as an answer: it empties what is
      // offered, which is how the defect becomes visible. Skipping it would
      // leave an unusable model in the picker, failing only once chosen.
      models = this.rejectUnusable(cache, models)
      for (const model of models) cache.known.set(model.id, model)
      const changed = cache.loaded && !sameCatalog(cache.models, models)
      cache.models = models
      // A first success is not a change: the caller that prompted it is holding
      // the very catalog the notification would tell it to reload.
      cache.loaded = true
      if (changed) this.announce()
    })().catch(() => {
      // The request itself is already contained above, so reaching here means
      // something unexpected — a malformed body, a listener that threw before
      // its own containment. This load is shared: rejecting it would fail every
      // caller waiting on it, for a catalog they can still be answered from.
    }).finally(() => {
      if (cache.inflight === load) cache.inflight = undefined
    })
    cache.inflight = load
    return load
  }

  /**
   * Keep the catalog entries this adapter can serve, reporting the ones it
   * cannot.
   *
   * ## What makes an entry unusable
   *
   * A model with no positive `limits.context_window`. The gateway's contract
   * says every entry carries one, and the harness cannot price a route without
   * it: `compaction-basic` throws `TargetPressureConfigError` on automatic
   * pressure and refuses a model switch outright
   * (`MODEL_SWITCH_COMPACTION_FAILED`). Such a model in the picker is one that
   * fails on the way to being used.
   *
   * ## Why the entry is dropped rather than passed on
   *
   * The index keeps a good reading for any model it has seen, precisely so a
   * retirement does not erase what the model was. A malformed entry is not a
   * better reading than that one, so it is dropped here and the earlier entry
   * survives untouched.
   *
   * ## Why the warning is once per id
   *
   * This runs on every refresh, every minute, for as long as the gateway has
   * the defect. A log line per minute is noise that hides its own signal; one
   * line per offending id is a report someone can act on.
   *
   * @param cache - the record, read for what it already knew.
   * @param models - the catalog just loaded.
   * @returns the entries that can be served.
   */
  private rejectUnusable(cache: ModelCatalogCache, models: readonly WireModel[]): readonly WireModel[] {
    const usable: WireModel[] = []
    for (const model of models) {
      const window = model.limits?.context_window
      if (typeof window === 'number' && window > 0) {
        usable.push(model)
        continue
      }
      // The message is what a person acts on: which model, what is wrong with
      // it, and who can fix it. The trailing clause only appears when the
      // index still holds a good reading, because that is when "the capacity
      // is preserved" is true and worth saying.
      if (!this.reportedUnusable.has(model.id)) {
        this.reportedUnusable.add(model.id)
        try {
          this.opts.warn?.(
            `aishell-llm: gateway model "${model.id}" declares no limits.context_window, `
            + 'so the harness cannot price a route to it; it is left out of the model picker'
            + (cache.known.has(model.id) ? ', and keeps the capacity it was last listed with' : '')
            + '. Report it to the gateway operator.',
          )
        } catch {
          // A logger that throws must not turn a refresh into a failure.
        }
      }
    }
    return usable
  }

  /**
   * Report that the advertised catalog changed.
   *
   * Contained: a listener this adapter does not own must not be able to turn a
   * successful refresh into a failed one.
   */
  private announce(): void {
    try {
      this.opts.onCatalogChanged?.()
    } catch {
      // Observer failures are the observer's problem.
    }
  }

  override async listModels(provider: string): Promise<readonly LlmModelInfo[]> {
    // No signal to forward: the base signature carries none, and a picker
    // abandons its own read rather than cancelling the listing other readers
    // are waiting on.
    const { models } = await this.readCatalog()
    return models.map(m => ({
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
    signal?: AbortSignal,
  ): Promise<LlmResolvedModelInfo> {
    const { known } = await this.readCatalog(signal)
    // The index rather than the current list: a model that just left the
    // catalog still has the capacities a running Turn needs, and only the
    // request itself can say it is gone.
    const wire = known.get(model)
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
    const efforts = wire.reasoning_effort
    // The gateway's declared cap, else the window share; see `outputCapFor`.
    // `max_prompt_tokens` is not read — no part of the harness enforces a
    // prompt ceiling, so a value there would be a second opinion nothing
    // consults.
    const maxTokens = typeof contextWindow === 'number'
      ? outputCapFor(contextWindow, wire.limits?.max_completion_tokens)
      : undefined

    return {
      ...base,
      ...(typeof contextWindow === 'number' && contextWindow > 0
        ? { context: { contextWindow } }
        : {}),
      ...(maxTokens === undefined ? {} : { defaultMaxTokens: maxTokens }),
      ...(Array.isArray(efforts) && efforts.length > 0
        ? { reasoning: { efforts: efforts.map(e => ({ id: e, name: e }) as LlmReasoningEffortInfo) } }
        : {}),
    }
  }

  /**
   * Whether a usable AK/SK pair is stored.
   *
   * The one predicate behind every "can this route do anything" question: the
   * catalog is empty without it, and the Models-page
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
    // The failure is the moment to ask again: the catalog the request was
    // routed from may be the stale one that still names this model. A refresh
    // is a no-op inside the TTL, so this costs a signed GET only when the
    // record is already due.
    const { models } = await this.readCatalog().catch(() => ({ models: NO_MODELS, known: NO_KNOWN }))
    const ids = models.map(m => m.id).filter(id => id.length > 0)
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
