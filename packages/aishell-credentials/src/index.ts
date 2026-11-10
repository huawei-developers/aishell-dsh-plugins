/**
 * aishell credentials host plugin.
 *
 * Owns Huawei Cloud AK/SK end to end: the browser half POSTs them to an
 * authenticated Host route, this half verifies them against Huawei Cloud IAM,
 * and only a verified set reaches the credential store (OS keyring with
 * memory fallback). Secrets never enter the settings document, so the profile
 * carries no plaintext at any point and the write path never touches the HMR
 * transaction that settings edits run inside.
 *
 * The route is registered through `ctx.connection.fetch`, the framework's
 * authenticated browser↔Host channel. Only the non-secret presence flag
 * `credentialsStored` and the verified account name `accessKeyIdHint` reach
 * the settings document, where the browser half reads them for the composer
 * chip and the settings section.
 *
 * This plugin owns credential management; `aishell-llm` only consumes the
 * stored credentials.
 *
 * @module @huaweidevtools/aishell-dsh-client-credentials
 */

import type { Context, Volatile } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
// Type-only: pulls the ctx.connection merge (the authenticated fetch registry).
import type {} from '@deepseek-ai/dsh-client-connection'
// Type-only: pulls the ctx.settings merge (SettingsForms) and the Fiber.entry
// merge (the Loader row whose id is this entry's settings namespace).
import type {} from '@deepseek-ai/dsh-settings'
import type {} from '@deepseek-ai/cordis-plugin-loader'
import { createCredentialsStore, type CredentialsStore } from '@huaweidevtools/aishell-dsh-credentials-store'
import {
  clearCredentials,
  hasStoredPair,
  readStoredPair,
  writeHuaweiCloud,
} from '@huaweidevtools/aishell-dsh-credentials-store/accounts'
import { verifyCredentials as verifyHuaweiCredentials } from '@huaweidevtools/aishell-dsh-credentials-store/verify'
import { CredentialFormBusy, registerAuthTool } from './auth-tool.ts'
import { FORM_REQUEST_FIELD, formRequest, type FormOutcome, type PendingFormRequest } from './form-request.ts'
import { encodeOutcome, LOGIN_OUTCOME_FIELD } from './login-status.ts'
import { createLoginFlow } from './out-of-band/flow.ts'
import {
  LOGIN_CANCEL_PATH,
  LOGIN_PROBE_ROUTE,
  LOGIN_START_PATH,
  createLoginRoutes,
} from './out-of-band/routes.ts'
import { PREFILL_PATH, readEnvPrefill } from './prefill.ts'
import {
  createCredentialReconciler,
  type RecordStatus,
  type StatusOp,
} from './reconcile.ts'

/**
 * Read the request token out of a save body.
 *
 * Parsed leniently: the route validates the body itself and answers 400 for a
 * malformed one, so this only has to avoid throwing on the way past. A missing
 * or unreadable token means "not an answer to a request", which is the right
 * behaviour for a chip-opened form.
 *
 * @param body - the raw request body.
 */
function readRequestToken(body: string): string | undefined {
  try {
    const parsed = JSON.parse(body) as { requestToken?: unknown } | null
    const token = parsed?.requestToken
    return typeof token === 'string' && token !== '' ? token : undefined
  } catch {
    return undefined
  }
}

/**
 * The host process's environment.
 *
 * Reached through a narrow cast rather than a typed `process`: this package
 * compiles without Node type definitions, so `process` is not in scope. The
 * host always has it; `{}` is the shape a build without one falls back to, and
 * an empty environment simply yields no prefill.
 *
 * @returns the environment, or an empty object when there is none.
 */
function runtimeEnv(): Record<string, string | undefined> {
  const holder = globalThis as { process?: { env?: Record<string, string | undefined> } }
  return holder.process?.env ?? {}
}

/** Plugin config — non-secret status the browser half reads. */
export interface Config {
  /** Presence flag the browser half reads; true once credentials reached the store. */
  credentialsStored: Volatile<boolean>
  /** Account name the Host's IAM verification wrote; the composer hint chip reads it. */
  accessKeyIdHint: Volatile<string>
  /** Readable verification failure the client form displays; set when the IAM check rejects. */
  lastError: Volatile<string>
  /**
   * A pending request to open the credential form, or `''`.
   *
   * Written by `aishell__auth` when it finds no credentials; read by the
   * browser half, which opens the form in the named session. A JSON token plus
   * session id — see `./form-request.ts` for why it is a token and not a
   * boolean, and why it travels the settings document rather than the fetch
   * channel.
   */
  credentialFormRequest: Volatile<string>
  /**
   * How the last browser login ended, or `''` when none has.
   *
   * Written by the host when the credential arrives and is stored; read by the
   * browser half, which shows the outcome and stops waiting. An outcome is
   * recorded rather than returned because the person may spend minutes at the
   * cloud, and an HTTP request held open that long is one a proxy will cut —
   * see `./out-of-band/flow.ts`.
   *
   * JSON, not several fields, so the browser half never observes a half-written
   * outcome. Carries no credential: only a kind and a name or a message.
   */
  loginOutcome: Volatile<string>
}

/**
 * Settings schema for this entry. Secrets are deliberately absent: they travel
 * over the credential route into the credential store, never through a
 * settings document.
 */
export const Config = z.object({
  credentialsStored: z.boolean().default(false).volatile(),
  accessKeyIdHint: z.string().default('').volatile(),
  lastError: z.string().default('').volatile(),
  credentialFormRequest: z.string().default('').volatile(),
  loginOutcome: z.string().default('').volatile(),
})

declare module '@deepseek-ai/cordis' {
  interface Events {
    /**
     * The stored Huawei Cloud credentials changed — a verified save, or a
     * clear. Emitted because `loader/volatile-update` is dispatched to the
     * owning fiber only, so a plugin that *consumes* credentials (rather than
     * owning the settings that describe them) has no other way to hear about a
     * rotation.
     *
     * Listeners read the credential store themselves; this event carries no
     * value, so a secret can never ride on it.
     *
     * @mode emit
     */
    'aishell/credentials-updated'(): void
  }
}

/** Route the browser half reads status from and saves credentials to. */
const CREDENTIALS_PATH = '/api/aishell/credentials'
/** Route the browser half clears credentials through (fetch routes have no DELETE). */
const CLEAR_PATH = '/api/aishell/credentials/clear'

/**
 * Route the browser calls when the person cancels the credential form.
 *
 * Separate from `clear`: cancelling says "not now" without touching the store.
 * What it does record is the cancel itself, so the next `auth` call can tell an
 * unanswered request from a refused one and stop asking.
 */
const CANCEL_PATH = '/api/aishell/credentials/cancel'

/**
 * Route the browser calls when the person confirms credentials already stored.
 *
 * The store is not touched, and nothing is verified: the card only offers this
 * when a credential is present, and the tool that asked re-reads and verifies
 * the store for itself. So this answers one question — "the person looked at
 * the account and is done" — and settles the request waiting on it.
 *
 * Why it has to exist at all: a signed-in person has no other way to answer a
 * blocked `aishell__auth`. The save route is the only other thing that settles
 * a request, and it needs a credential to post; without this, someone who was
 * already authenticated could only leave the card by logging out, which
 * destroys the credential the call was waiting to use.
 */
const CONFIRM_PATH = '/api/aishell/credentials/confirm'

/** Largest credential body accepted; a real payload is well under 1 KiB. */
const MAX_BODY_BYTES = 8 * 1024

/** Verification outcome carried back to the browser. */
interface SaveResult {
  readonly ok: boolean
  /** Verified account (domain) name; present only on success. */
  readonly accountName?: string
  /** User-readable failure; present only on rejection. */
  readonly error?: string
}

/**
 * Verify credentials against Huawei Cloud IAM and return the account name.
 *
 * Delegates to the shared `verify` module, so the form, the ops `auth` tool
 * and anything else that asks "are these credentials valid?" get the same
 * answer from the same endpoint (profile: `GET /v3/projects`, with the account
 * name read best-effort from `/v3/auth/domains`).
 *
 * ## Why the shared verifier rather than a narrower call
 *
 * The form's own question is "is this pair valid", and the answer has to agree
 * with the one the tools get — otherwise it accepts credentials the tools then
 * refuse. A narrower check would do exactly that: `/v3/projects` rejects a
 * credential with no visible project, while a domains-only call accepts it, so
 * the form would say "saved" for a pair that fails on the first real call. One
 * verifier removes that gap, and the project list it returns is what a caller
 * needs before planning a deployment anyway.
 *
 * ## The region
 *
 * IAM is global: the region only routes to a regional replica and does not
 * scope the result. The chip's copy is fixed at `cn-north-4` for routing
 * purposes rather than configured, because verification must succeed even
 * before a person has chosen a region — and because a wrong region here would
 * report "invalid credentials" for what is really a typo'd region setting
 * elsewhere.
 *
 * @returns the account name (domain name), falling back to the account id.
 * @throws {CredentialRejectedError} when IAM refused the credential itself —
 *   the only failure that says the stored pair is unusable.
 * @throws {Error} for every other failure, with a user-readable message.
 */
async function verifyCredentials(ak: string, sk: string, securityToken?: string): Promise<string> {
  const result = await verifyHuaweiCredentials(
    { ak, sk, ...(securityToken === undefined ? {} : { securityToken }) },
    { region: VERIFY_REGION },
  )
  if (result.ok) return result.account.name
  if (isRejection(result.status)) throw new CredentialRejectedError(result.message)
  throw new Error(result.message)
}

/**
 * Whether IAM's answer is about the credential rather than about the call.
 *
 * The distinction decides whether the stored pair is discarded, so it is drawn
 * narrowly. Only 401 and 403 mean "this credential is not usable":
 *
 *   - `0` never reached IAM — a DNS failure, a proxy, a timeout. The credential
 *     may be perfectly good, and clearing it would log the person out because
 *     their network blipped.
 *   - A 5xx is IAM failing rather than refusing. Same conclusion.
 *   - A 200 that failed business validation (no visible project, projects from
 *     two accounts) arrives with the credential ACCEPTED — the answer is about
 *     authorisation or account shape, and re-entering the same pair changes
 *     nothing.
 *
 * @param status - the HTTP status IAM answered with, or `0`.
 * @returns whether the credential was refused.
 */
function isRejection(status: number): boolean {
  return status === 401 || status === 403
}

/**
 * IAM refused the credential itself.
 *
 * A distinct type because the caller does something a plain failure must not
 * trigger: it discards what is stored. The type is what keeps that decision
 * from being re-derived, differently, at every call site.
 */
class CredentialRejectedError extends Error {
  override readonly name = 'CredentialRejectedError'
}

/**
 * Region used to route the verification call.
 *
 * Not a setting: see {@link verifyCredentials}. Any region replica answers the
 * same question.
 */
const VERIFY_REGION = 'cn-north-4'


/** One JSON error response the browser half renders verbatim. */
function jsonError(status: number, message: string): Response {
  return Response.json({ ok: false, error: message }, { status })
}

/**
 * Read a bounded JSON object body, or throw a user-readable message.
 *
 * ## Why the bound is checked before the read finishes
 *
 * The body is drained first and measured after, which is the only order the
 * `Request` API allows: it exposes no streaming reader for a buffered route.
 * That means the bound cannot prevent the memory a large body costs — it stops
 * a hostile body from being *parsed* and from reaching any code that assumes a
 * credential, which is what it is for here. The transport's own request cap is
 * the memory bound; this one guards the next step.
 *
 * ## Why bytes and not `text.length`
 *
 * `text.length` counts UTF-16 code units, so a body of three-byte characters
 * measures a third of its real size and slips under a bound it should not. The
 * limit is stated in bytes, so it is compared in bytes.
 *
 * @param request - the buffered request.
 * @returns the parsed object.
 * @throws when the body is too large, is not JSON, or is not an object.
 */
async function readJsonBody(request: Request): Promise<Record<string, unknown>> {
  const text = await request.text()
  const bytes = new TextEncoder().encode(text).length
  if (bytes > MAX_BODY_BYTES) throw new Error('Request body too large.')
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new Error('Request body is not valid JSON.')
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('Request body must be a JSON object.')
  }
  return parsed as Record<string, unknown>
}

/** Narrow one optional string field; absent and empty both read as undefined. */
function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

/** Collaborators the credential routes run against; injected so they are testable. */
export interface CredentialRoutesDeps {
  /** Durable credential store the verified set is transferred into. */
  readonly store: CredentialsStore
  /** Verifies AK/SK (and optional token) against Huawei Cloud IAM; resolves the account name. */
  readonly verify: (ak: string, sk: string, token?: string) => Promise<string>
  /** Records the non-secret status the browser half reads. */
  readonly recordStatus: (ops: Parameters<Context['settings']['mutate']>[1]) => void
  /** Reads the cached account-name hint for the status response. */
  readonly hint: () => string
  /**
   * Announces that the stored credentials changed, so consumers that cached
   * something derived from them (a resolved account identity, a sandbox key)
   * can drop it. Called only after the store actually changed — a rejected save
   * stores nothing and stays silent.
   */
  readonly notifyChanged: () => void
}

/**
 * The three credential routes, bound to their collaborators.
 *
 * Returned as plain `(request) => Promise<Response>` handlers so a test can
 * drive them with a real `Request` and assert on the `Response` alone — the
 * behavior worth pinning is that a rejected credential stores nothing and that
 * no response ever carries a secret.
 */
export function createCredentialRoutes(deps: CredentialRoutesDeps): {
  get: () => Promise<Response>
  save: (request: Request) => Promise<Response>
  clear: () => Promise<Response>
} {
  const { store, verify, recordStatus, hint, notifyChanged } = deps

  return {
    // Status only. This view has no slot a secret could ride in.
    get: (): Promise<Response> => Promise.resolve(Response.json(
      {
        configured: hasStoredPair(store),
        accountName: hint(),
      },
      { headers: { 'cache-control': 'no-store' } },
    )),

    // Verify against IAM, and only then transfer into the credential store.
    // A rejected set stores nothing and leaves the keyring untouched.
    save: async (request: Request): Promise<Response> => {
      let body: Record<string, unknown>
      try {
        body = await readJsonBody(request)
      } catch (error) {
        return jsonError(400, error instanceof Error ? error.message : String(error))
      }
      const ak = optionalString(body.accessKeyId)
      const sk = optionalString(body.secretAccessKey)
      const token = optionalString(body.securityToken)
      if (!ak || !sk) return jsonError(400, 'Access Key and Secret Key are both required.')

      let accountName: string
      try {
        accountName = await verify(ak, sk, token)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        recordStatus([{ op: 'set', path: ['lastError'], value: message }])
        return Response.json({ ok: false, error: message } satisfies SaveResult, { status: 422 })
      }

      try {
        // One write for the whole pair. The store keeps a single record, so
        // this is one atomic operation: a rotation can never leave one half of
        // a previous pair behind, and a reader can never catch the two mid-way.
        // A save without a token replaces the previous one rather than
        // inheriting it.
        writeHuaweiCloud(store, {
          ak,
          sk,
          ...(token === undefined ? {} : { securityToken: token }),
        })
      } catch (error) {
        const message = `Credential verified, but storing it failed: ${error instanceof Error ? error.message : String(error)}`
        recordStatus([{ op: 'set', path: ['lastError'], value: message }])
        return jsonError(500, message)
      }

      recordStatus([
        { op: 'set', path: ['credentialsStored'], value: true },
        { op: 'set', path: ['accessKeyIdHint'], value: accountName },
        { op: 'unset', path: ['lastError'] },
      ])
      notifyChanged()
      return Response.json({ ok: true, accountName } satisfies SaveResult)
    },

    // Fetch routes have no DELETE, so clearing is a POST.
    //
    // The store's delete can refuse — a locked keyring rejects deletes, and an
    // unreadable encrypted file cannot be rewritten — and a refusal means the
    // credential is still there. Letting that escape would reach the browser as
    // a transport failure with no body, and the card would report "could not
    // reach the host" over a credential that is still stored. So it is caught
    // and answered as a refusal: the status is left alone (it still says
    // `configured`), and the message says what happened.
    clear: (): Promise<Response> => {
      try {
        clearCredentials(store)
      } catch (error) {
        const message = `Could not clear the stored credentials: ${error instanceof Error ? error.message : String(error)}`
        recordStatus([{ op: 'set', path: ['lastError'], value: message }])
        return Promise.resolve(jsonError(500, message))
      }
      recordStatus([
        { op: 'set', path: ['credentialsStored'], value: false },
        { op: 'unset', path: ['accessKeyIdHint'] },
        { op: 'unset', path: ['lastError'] },
      ])
      notifyChanged()
      return Promise.resolve(Response.json({ ok: true } satisfies SaveResult))
    },
  }
}

export const name = 'aishell-client-credentials'
export const inject = ['settings', 'connection']

export function apply(ctx: Context, config: Config): void {
  // One store, against the namespace every plugin in this set shares.
  const store: CredentialsStore = createCredentialsStore()
  // Settings namespace of this entry is the Loader row id; absent when mounted
  // without the Loader, where there is no profile document to record status in.
  const ns = ctx.fiber.entry?.options.id

  // Memory mirror of the status this plugin last recorded.
  //
  // `recordStatus` writes through `ctx.settings.mutate`, which persists into
  // the profile patch and flows back into this plugin's volatile config via
  // the loader's `_commitVolatile`. The mirror is
  // kept anyway for two reasons the config path does not cover:
  //   1. `mutate` is async; `config.accessKeyIdHint.get()` only reflects a
  //      write after `_commitVolatile` runs. The GET route reads the mirror so
  //      `accountName` is correct the instant `recordStatus` returned.
  //   2. When this entry is mounted without a Loader row (`ns === undefined`),
  //      `recordStatus` is a no-op — the mirror is then the only readback the
  //      GET route has.
  //
  // The mirror must track what the *document* holds, not what was last
  // requested: `readStored`/`readHint` are the reconciler's baseline for
  // "already recorded, nothing to send", so a mirror that advanced past a
  // failed write would make reconcile believe the status was recorded and stop
  // retrying it — leaving the browser reading the untouched document (it reads
  // `configForms`, not this mirror) while every server-side reader sees the new
  // value. The catch below therefore puts the mirror back.
  let recordedStored = config.credentialsStored.get() === true
  let recordedHint: string | null = config.accessKeyIdHint.get() || null

  /**
   * The form request a tool call is currently blocked on.
   *
   * Held here rather than read from the document: the answer arrives over the
   * credential and cancel routes, and those need the same object the tool is
   * awaiting.
   */
  let pendingForm: PendingFormRequest | undefined

  /**
   * Settle the pending request and withdraw it from the document.
   *
   * One helper on purpose: the field is **persisted** — it is this entry's row
   * in the profile — so a request left in the document outlives the call that
   * made it. On the next boot the browser half reads that stale value and opens
   * the form for a question nobody is asking, which is why a fresh install
   * showed a credential form unprompted.
   *
   * Every path that answers a request goes through here. Writing the clear
   * beside each settle instead would work until someone added a path and
   * forgot, and the symptom would be an unexplained form on a later boot.
   *
   * @param outcome - what the person did, or `undefined` to abandon without
   *   answering (used for the release path, where nothing is waiting).
   * @param expected - the request being settled. When given, a settle for a
   *   different request is ignored, so a late answer cannot clear a form
   *   somebody else is looking at.
   */
  const settleFormRequest = (
    outcome: FormOutcome | undefined,
    expected?: PendingFormRequest,
  ): void => {
    if (expected !== undefined && pendingForm !== expected) return
    const pending = pendingForm
    pendingForm = undefined
    if (pending !== undefined && outcome !== undefined) pending.settle(outcome)
    if (ns !== undefined) {
      void ctx.settings.mutate(ns, [
        { op: 'unset', path: [FORM_REQUEST_FIELD] },
      ]).catch((error: unknown) => { ctx.logger.warn(error) })
    }
  }

  /**
   * Answer one form request, named by the token in the body.
   *
   * The cancel and confirm routes differ only in which outcome they record, so
   * they share this. Both need the same three things, and each is a failure
   * this has to get right:
   *
   *   - **The body is read defensively.** A malformed one earns a `400` rather
   *     than an exception, so the browser always receives JSON it can render.
   *   - **The token decides which request is answered.** The browser can
   *     deliver a stale answer after a reconnect, and settling whichever
   *     request happens to be pending would end a form the person is looking
   *     at — or, worse, tell a model the user declined something they did not.
   *   - **An unmatched token is not an error.** The request it named is
   *     already gone; there is nothing to do and the browser needs no message.
   *
   * @param kind - the outcome to record against the named request.
   * @returns the route handler.
   */
  const settleByToken = (kind: FormOutcome['kind']) =>
    async (request: Request): Promise<Response> => {
      let body: unknown
      try {
        body = await request.json()
      } catch {
        return jsonError(400, 'Request body is not valid JSON.')
      }
      const token = (body as { token?: unknown } | null | undefined)?.token
      if (typeof token !== 'string' || token === '') {
        return jsonError(400, 'token is required.')
      }
      if (pendingForm !== undefined && pendingForm.request.token === token) {
        settleFormRequest({ kind }, pendingForm)
      }
      return Response.json({ ok: true })
    }

  /** Apply one batch of ops to the mirror. */
  const mirrorOps = (ops: readonly StatusOp[]): void => {
    for (const op of ops) {
      if (op.path[0] === 'credentialsStored') {
        recordedStored = op.op === 'set' && op.value === true
      } else if (op.path[0] === 'accessKeyIdHint') {
        recordedHint = op.op === 'set' && typeof op.value === 'string' && op.value.length > 0
          ? op.value
          : null
      }
    }
  }

  /** Record the non-secret status the browser half reads; a refused write is rolled back. */
  const recordStatus: RecordStatus = (ops) => {
    // No Loader row: there is no document to write, so the mirror is the whole
    // state and nothing can fail — reason (2) above.
    if (ns === undefined) {
      mirrorOps(ops)
      return
    }
    const before = { stored: recordedStored, hint: recordedHint }
    // Applied before the write so the GET route answers with the new value
    // without waiting for `_commitVolatile` — reason (1) above.
    mirrorOps(ops)
    const after = { stored: recordedStored, hint: recordedHint }
    void ctx.settings.mutate(ns, ops).catch((error: unknown) => {
      // The refused write only logs, but the mirror must not keep the value the
      // document never received. Revert only when the mirror still holds what
      // this call wrote: a later write that has since moved it owns the current
      // value, and its own outcome decides.
      if (recordedStored === after.stored && recordedHint === after.hint) {
        recordedStored = before.stored
        recordedHint = before.hint
      }
      ctx.logger.warn(error)
    })
  }

  const routes = createCredentialRoutes({
    store,
    verify: verifyCredentials,
    recordStatus,
    // Read the mirror, not config: the mirror is updated synchronously inside
    // `recordStatus`, so the GET route answers with the value just written
    // even before `_commitVolatile` flows it back into config.
    hint: () => recordedHint ?? '',
    notifyChanged: () => { ctx.emit('aishell/credentials-updated') },
  })

  // Re-derives `credentialsStored` and `accessKeyIdHint` from the store: on
  // boot, on a timer, and on every GET. The re-reads are what let a credential
  // written while the process runs reach the UI without a restart.
  const reconciler = createCredentialReconciler({
    verify: verifyCredentials,
    // The verify above throws a typed error for a refusal, so this asks the
    // error, not its message. A message check would break the first time the
    // wording changed.
    isRejection: (error: unknown): boolean => error instanceof CredentialRejectedError,
    recordStatus,
    readStored: () => recordedStored,
    readHint: () => recordedHint,
    readPair: () => readStoredPair(store),
    // A refused credential is removed from the store, so the interface returns
    // to "not configured" rather than showing an account name beside a sign-in
    // form. `notifyChanged` is called because consumers cache things derived
    // from this pair — a resolved account identity, a sandbox key — and a pair
    // that IAM refused must not keep serving them.
    discard: () => {
      clearCredentials(store)
      ctx.emit('aishell/credentials-updated')
    },
  })

  // ── The credential form ──────────────────────────────────────────────────
  //
  // The form is opened by the chips, from the browser, and nothing on the host
  // side pushes it open. There is no tool call that blocks waiting for
  // credentials, so there is no request to mirror and nothing to settle.
  //
  // That single direction is deliberate. A host-to-browser request channel
  // would carry secrets across a boundary that exists only to serve a call
  // nobody makes, and a dormant path that carries secrets is worse than absent
  // code: it is the shape of a future leak, with no caller to keep it correct.

  // One registration per path: the route registry keys on the path and holds a
  // method set, so GET and POST on the same path must share one entry. The GET
  // arm also reconciles: a browser or operator checking status hands the
  // reconciler a chance to pick up a store change the timer has not ticked on
  // yet, so the answer is never stale by more than the call's own latency.
  ctx.effect(() => ctx.connection.fetch.register({
    path: CREDENTIALS_PATH,
    methods: ['GET', 'POST'],
    requestBody: 'buffered',
    fetch: async (request: Request): Promise<Response> => {
      if (request.method === 'GET') return (reconciler.reconcile(), routes.get())
      // The body is read here and handed on, because it names the request this
      // submit answers: a save that arrives without one came from a
      // chip-opened form, which nobody is waiting on.
      //
      // `request.text()` rather than a JSON parse: the route validates the body
      // itself and answers 400 for a malformed one, so parsing here would only
      // duplicate that check. The token is read aloud from the same bytes.
      const body = await request.text()
      const requestToken = readRequestToken(body)
      const response = await routes.save(new Request(request.url, {
        method: 'POST',
        headers: request.headers,
        body,
      }))
      // An accepted save means the person submitted. The tool re-reads the
      // store and verifies; a rejected pair leaves the wait open, and the
      // tool's loop reopens the form for a corrected one.
      if (response.ok && requestToken !== undefined
        && pendingForm !== undefined && pendingForm.request.token === requestToken) {
        settleFormRequest({ kind: 'submitted' }, pendingForm)
      }
      return response
    },
  }), 'aishell-credentials: credentials route')

  // Cancelling a form request. The token names which request was cancelled —
  // the person may have cancelled one that has since been superseded, and
  // recording the wrong one would silence a request nobody answered.
  ctx.effect(() => ctx.connection.fetch.register({
    path: CANCEL_PATH,
    methods: ['POST'],
    requestBody: 'buffered',
    fetch: settleByToken('cancelled'),
  }), 'aishell-credentials: cancel route')

  // Confirming credentials already stored. Settles as `submitted`, not
  // `cancelled`: the person did not decline, they confirmed an account the
  // store already holds, and the tool that asked re-reads and verifies it on
  // waking.
  ctx.effect(() => ctx.connection.fetch.register({
    path: CONFIRM_PATH,
    methods: ['POST'],
    requestBody: 'buffered',
    fetch: settleByToken('submitted'),
  }), 'aishell-credentials: confirm route')

  // Environment prefills for the form. Read once per open, never persisted:
  // the values go host -> page and nowhere else. See `./prefill.ts` for why
  // this is a route rather than something the browser reads itself.
  ctx.effect(() => ctx.connection.fetch.register({
    path: PREFILL_PATH,
    methods: ['GET'],
    requestBody: 'buffered',
    fetch: () => Promise.resolve(Response.json(readEnvPrefill(runtimeEnv()) ?? {},
      {
        headers: { 'cache-control': 'no-store' },
      },
    )),
  }), 'aishell-credentials: prefill route')

  // ── Browser login ────────────────────────────────────────────────────────
  //
  // The out-of-band flow: the cloud posts a credential straight to a loopback
  // socket on this machine, so the flow has to be the host's — it binds the
  // socket, fetches the provider's callback plan, verifies the credential and
  // stores it. The browser half only opens the URL and watches for the outcome.
  //
  // Why it is offered at all: a person signing in with a browser never has to
  // find their way to a console and copy a key. Why it may not be: the
  // callback goes to `127.0.0.1` as resolved by *the browser's* machine, so
  // this only works when the browser and the host are the same machine. That
  // is not knowable from either side — an SSH-forwarded session makes a
  // distant browser look local to the host and a distant host look local to
  // the page — so the browser half proves it with a probe instead of
  // inferring it. See `./out-of-band/listener.ts`.
  /**
   * Announces that the stored credentials changed, so consumers that cached
   * something derived from them drop it.
   *
   * Declared before the flow because `recordOutcome` is where a successful
   * login is known, and that is the point at which the store has just changed.
   */
  const announceCredentialsChanged = (): void => { ctx.emit('aishell/credentials-updated') }

  const loginFlow = createLoginFlow({
    // Verification returns the account name on success and throws otherwise.
    // The flow treats a throw as the end of the login, so a credential the
    // cloud rejects is never stored; the name it returns is what the outcome
    // reports, because the store's own hint lags this write by a reconcile
    // tick.
    verify: async (credential) => {
      return await verifyCredentials(credential.accessKeyId, credential.secretAccessKey, credential.securityToken)
    },
    store: (credential) => {
      writeHuaweiCloud(store, {
        ak: credential.accessKeyId,
        sk: credential.secretAccessKey,
        ...(credential.securityToken === undefined ? {} : { securityToken: credential.securityToken }),
      })
      return Promise.resolve()
    },
    recordError: (error) => {
      recordStatus([{ op: 'set', path: ['lastError'], value: error }])
    },
    recordOutcome: (outcome) => {
      recordStatus([{ op: 'set', path: [LOGIN_OUTCOME_FIELD], value: encodeOutcome(outcome) }])
      if (outcome?.kind !== 'succeeded') return

      // The same status a submitted credential records, because this is the
      // same event: the store now holds a verified pair. The chip reads
      // `accessKeyIdHint` for both its label and its "configured" test, so
      // omitting it left the chip saying "no credentials" over an account that
      // was already authenticated — until the reconcile loop's next tick,
      // which is up to thirty seconds later and not a thing to wait for.
      recordStatus([
        { op: 'set', path: ['credentialsStored'], value: true },
        { op: 'set', path: ['accessKeyIdHint'], value: outcome.accountName },
        { op: 'unset', path: ['lastError'] },
      ])
      // A successful login changed the stored credential, so consumers that
      // cached something derived from it must drop it — the same announcement
      // a form save makes.
      announceCredentialsChanged()
      // The card's job is done, and that is a *tool* fact as much as a UI
      // one: `aishell__auth` is blocked on the request this form answers, and
      // the browser half closing the card does not reach it — `close` only
      // withdraws the interaction. Without settling here the credential would
      // be stored, the card gone, and the call that asked for it still
      // waiting until the turn ended.
      //
      // The same settle the submit route performs, for the same reason: the
      // store has just changed, and the tool re-reads it on waking.
      settleFormRequest({ kind: 'submitted' })
    },
  })

  const loginRoutes = createLoginRoutes({
    findProvider: loginFlow.findProvider,
    probe: loginFlow.probe,
    begin: loginFlow.begin,
    cancel: loginFlow.cancel,
    inProgress: loginFlow.inProgress,
  })

  // One registration per path, like the credential routes above: the registry
  // keys on the path.
  //
  // The probe is its own route because it answers a different question, asked
  // at a different time: "can a browser here reach a loopback socket", which
  // the card needs before it can offer the button at all.
  ctx.effect(() => ctx.connection.fetch.register({
    path: LOGIN_PROBE_ROUTE,
    methods: ['POST'],
    requestBody: 'buffered',
    fetch: loginRoutes.probe,
  }), 'aishell-credentials: browser login probe route')

  ctx.effect(() => ctx.connection.fetch.register({
    path: LOGIN_START_PATH,
    methods: ['POST'],
    requestBody: 'buffered',
    fetch: loginRoutes.start,
  }), 'aishell-credentials: browser login start route')

  ctx.effect(() => ctx.connection.fetch.register({
    path: LOGIN_CANCEL_PATH,
    methods: ['POST'],
    requestBody: 'buffered',
    fetch: loginRoutes.cancel,
  }), 'aishell-credentials: browser login cancel route')

  // A login holds a loopback port and a pending promise. Neither should outlive
  // the plugin: a reload that left the port bound would make the next attempt
  // fail in a way that looks like the OS refusing a port for no reason.
  ctx.effect(() => () => { loginFlow.cancel() }, 'aishell-credentials: browser login teardown')

  ctx.effect(() => ctx.connection.fetch.register({
    path: CLEAR_PATH,
    methods: ['POST'],
    requestBody: 'buffered',
    // The clear route wipes the store; the reconciler's verify baseline must be
    // dropped too, so an in-flight verification whose `.then` lands after the
    // clear is fenced out (it re-checks the store, and the baseline no longer
    // matches the cleared material).
    fetch: () => { reconciler.resetVerifyBaseline(); return routes.clear() },
  }), 'aishell-credentials: clear route')

  // Re-derive the status from the store now (boot) and on a timer, so a
  // credential written after boot — the env's `sync-hw-creds` writes the
  // keyring every minute, and the first write can land after this plugin
  // started — surfaces in the UI within the next tick, without a restart.
  //
  // Steady state costs one keyring read per tick (the bundle), measured at
  // ~13ms on a Linux KWallet host — not the microseconds a "kernel syscall"
  // figure would suggest, because `KeyringBackend` builds a fresh `Entry` per
  // call and that construction dominates the read. It is a synchronous API, so
  // the tick blocks the event loop. ~13ms every 30s is negligible and worth the
  // staleness it removes, but it is not free: raising this frequency is not a
  // cheap knob.
  reconciler.reconcile()
  const reconcileTimer = setInterval(reconciler.reconcile, 30_000)
  ctx.effect(() => () => clearInterval(reconcileTimer),
    'aishell-credentials: status reconcile timer')

  // Any request in the document at startup is stale, and answering it is the
  // bug this clears. The field is persisted, so a request written by a previous
  // process survives into this one; nothing can be waiting on it, because the
  // call that asked was ended by whatever ended that process. Left in place,
  // the browser half reads it on its first pass and opens the form for a
  // question nobody is asking — which is exactly what a fresh install did.
  //
  // Only when there is something to remove: on an ordinary boot the field is
  // already empty, and writing to say so would be a settings mutation per start
  // for no change — plus a failure to acquire the document lock would log a
  // warning about nothing.
  if (ns !== undefined && config.credentialFormRequest.get() !== '') {
    void ctx.settings.mutate(ns, [
      { op: 'unset', path: [FORM_REQUEST_FIELD] },
    ]).catch((error: unknown) => { ctx.logger.warn(error) })
  }

  // The `auth` tool: verify the stored credentials and report the account.
  //
  // It lives here rather than in `aishell-deploy` because it answers a
  // question this package owns — "is this account authenticated, and as whom?"
  // — and because the form that collects AK/SK is here. It is registered behind
  // a soft `tools` injection: a host without a tool registry should lose the
  // tool, not lose credential management.
  registerAuthTool(ctx, store, {
    // Opens the form and returns the promise the tool blocks on. The request
    // is written into this entry's own settings document, so the browser half
    // sees it through `configForms`; the submit and cancel routes settle it.
    requestForm: (sessionId) => {
      if (ns === undefined) {
        // No Loader row: there is no document to write and no browser half to
        // read it, so no form can appear and the tool must fail instead of
        // waiting for an answer that cannot come.
        return undefined
      }
      // One request at a time, and two outcomes depending on who is asking.
      //
      // SAME conversation: join it. Two calls blocked on credentials in one
      // session are waiting for the same person to fill the same form; a second
      // that superseded the first would settle it `cancelled` and tell that
      // model the user had refused, which the user never did. Same reasoning
      // `SandboxKeySource` uses for concurrent key creates.
      //
      // DIFFERENT conversation: refuse. The request document holds ONE request,
      // so writing a second overwrites the first — the form in that
      // conversation would vanish with nobody having answered it, and its caller
      // would wait for a request no longer on screen. `CredentialFormBusy` says
      // so at once instead.
      //
      // The refusal is about the DOCUMENT, not about the person being unable to
      // find the form: a chip press navigates to whichever conversation owns the
      // open card (see `client/credential-form-visibility.ts`), so the person
      // has a way to it. What they cannot do is have two `auth` calls waiting
      // from two conversations at once.
      //
      // No timeout, deliberately. A person fetching a key can legitimately take
      // minutes, so any deadline would be a guess, and the request is released
      // by a definite event instead: the turn being stopped, or the form being
      // answered. See `CredentialFormBusy`.
      if (pendingForm !== undefined) {
        if (pendingForm.request.sessionId === sessionId) return pendingForm.outcome
        throw new CredentialFormBusy()
      }
      const pending = formRequest(sessionId)
      pendingForm = pending
      void ctx.settings.mutate(ns, [
        { op: 'set', path: [FORM_REQUEST_FIELD], value: pending.encoded },
      ]).catch((error: unknown) => {
        ctx.logger.warn(error)
        // The request never reached the browser, so nobody will answer it.
        settleFormRequest({ kind: 'cancelled' }, pending)
      })
      return pending.outcome
    },
    // A call that stopped waiting gives the shared request back, so the next
    // caller starts a fresh form instead of joining a promise nothing will
    // settle — the bug where a stopped turn left `auth` showing no form at all.
    //
    // Settled before it is dropped, because a second call may have joined this
    // same request: clearing the slot alone would leave that caller awaiting a
    // promise the submit and cancel routes can no longer reach. The outcome is
    // `cancelled` because it is the only one that says "this form produced no
    // credential", which is true however the first caller came to leave.
    releaseForm: () => {
      settleFormRequest({ kind: 'cancelled' })
      // The login listener goes with it. A stopped turn may have been sitting
      // on the waiting page, and that page's browser half is gone with the
      // turn — nothing else will call the cancel route, so the socket would
      // stay bound for the life of the process. Idempotent: with no login
      // running this does nothing.
      loginFlow.cancel()
    },
    // IAM refused the stored pair this call was holding. Same action the
    // reconciler takes on a refusal, reached sooner: the tool found out while a
    // person was waiting for an answer, so the interface stops offering a
    // signed-in view that cannot work.
    discard: () => {
      clearCredentials(store)
      // The recorded status follows the store at once, not on the next
      // reconcile tick: the form this call is about to open reads it, and a
      // stale `credentialsStored: true` would draw the signed-in card with
      // nothing behind it.
      recordStatus([
        { op: 'set', path: ['credentialsStored'], value: false },
        { op: 'unset', path: ['accessKeyIdHint'] },
      ])
      announceCredentialsChanged()
    },
  })

  // The browser half renders the credential form; suppress the auto-generated
  // settings page (the namespace must still exist for the status fields the
  // form and the chips read).
  ctx.effect(() => ctx.settings.configure({ auto: false }, ctx.fiber))
}
