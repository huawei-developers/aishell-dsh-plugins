/**
 * The credential form's Host-side control.
 *
 * ## What this is for
 *
 * `aishell__auth` needs credentials that are not there. It cannot collect them
 * — a credential a tool returns is a credential in the transcript — so it asks
 * for the form to be put on screen, the person fills it, and the model calls
 * `auth` again.
 *
 * ## Why the settings document carries the request
 *
 * The two halves live apart: the tool runs on the host, the form is browser
 * code. The host cannot reach the browser over the fetch channel — that channel
 * is browser→host only — so the request has to ride something the browser
 * already watches. The settings document is exactly that: the browser half
 * subscribes to this entry's config through `configForms`, and a volatile field
 * written by the host shows up there.
 *
 * The document carries **only** a request token and a session id. Never a
 * credential, never a verdict — those travel the other way, over the
 * credential route, and the browser never receives a stored secret at all.
 *
 * ## Why the token, not a boolean
 *
 * The browser has to tell "a new request" from "the request it already opened".
 * With a boolean, a second `auth` failure while the form is up would look
 * identical to the first and the form would not re-open after the person
 * cancelled it. The token changes on every request, and the browser compares it
 * to the last one it acted on.
 *
 * ## Why nothing is awaited
 *
 * The tool cannot wait for the person — a tool call has no way to be paused for
 * a human. So `auth` fails, the form appears, and the model calls again. That
 * round trip is the whole protocol, and it is why the failure message and the
 * form are worded as a pair.
 *
 * @module @huaweidevtools/aishell-dsh-client-credentials/form-request
 */

/** Field of this entry's config that carries one pending request. */
export const FORM_REQUEST_FIELD = 'credentialFormRequest'

/** What the browser reads out of that field. */
export interface CredentialFormRequest {
  /**
   * Identity of this request; a fresh value means "open the form again even if
   * you opened one before".
   */
  readonly token: string
  /** Conversation to render the form in. */
  readonly sessionId: string
}

/** Writes one path-addressed edit into this entry's settings document. */
export type RecordField = (value: string) => void

/**
 * How one form request ended.
 *
 * `submitted` carries no credential: the form posts to the credential route,
 * which verifies and writes the store, so the tool reads the store afterwards.
 * Nothing about this answer is secret, which is what lets it cross the host
 * without a second review of the leak surface.
 */
export type FormOutcome =
  /** The person submitted. The store may or may not hold a usable pair. */
  | { readonly kind: 'submitted' }
  /** The person cancelled. */
  | { readonly kind: 'cancelled' }

/**
 * Build a request for one session, minting its token.
 *
 * The token is minted here rather than by the caller so a request cannot be
 * recorded without one — the browser's "is this new?" test would then be
 * comparing against nothing, and the form would not reopen after a cancel.
 *
 * @param sessionId - the conversation the form should render in.
 * @returns the request, and its encoded form for the settings document.
 */
export function formRequest(sessionId: string): PendingFormRequest {
  // Monotonic and process-local: the browser only compares tokens, so it needs
  // uniqueness rather than meaning. A counter keeps it from depending on the
  // clock, which can repeat under an adjusted system time.
  nextToken += 1
  const request: CredentialFormRequest = {
    token: `${Date.now().toString(36)}-${String(nextToken)}`,
    sessionId,
  }
  const completion = Promise.withResolvers<FormOutcome>()
  return {
    request,
    encoded: encodeRequest(request),
    outcome: completion.promise,
    settle: (outcome) => { completion.resolve(outcome) },
  }
}

/**
 * One request, and the promise its waiting caller is blocked on.
 *
 * The token is what a submit or a cancel names when it answers, so an answer
 * for a superseded request cannot settle the current one.
 */
export interface PendingFormRequest {
  readonly request: CredentialFormRequest
  readonly encoded: string
  /** Resolves when the person submits or cancels. */
  readonly outcome: Promise<FormOutcome>
  /** Answer this request. Idempotent: a second call is ignored by `Promise`. */
  readonly settle: (outcome: FormOutcome) => void
}

/** Source of tokens; module-scoped so it is per-host-process. */
let nextToken = 0

/**
 * Serialize a request for the settings document.
 *
 * The document holds strings — a volatile `string` field is what the browser
 * half reads through `configForms` — so the request is JSON. Encoding rather
 * than reshaping the config into several fields keeps the request atomic: the
 * browser cannot observe a new token with an old session.
 *
 * @param request - the request to encode.
 */
export function encodeRequest(request: CredentialFormRequest): string {
  return JSON.stringify(request)
}

/**
 * Read a request back out of the document.
 *
 * Anything unreadable reads as no request: a corrupt field should show nothing,
 * not open a form bound to a session that does not exist.
 *
 * @param raw - the stored string, if any.
 * @returns the request, or `undefined` when there is none usable.
 */
export function decodeRequest(raw: string | undefined): CredentialFormRequest | undefined {
  if (raw === undefined || raw === '') return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return undefined
  }
  if (parsed === null || typeof parsed !== 'object') return undefined
  const candidate = parsed as { token?: unknown, sessionId?: unknown }
  if (typeof candidate.token !== 'string' || candidate.token === '') return undefined
  if (typeof candidate.sessionId !== 'string' || candidate.sessionId === '') return undefined
  return { token: candidate.token, sessionId: candidate.sessionId }
}