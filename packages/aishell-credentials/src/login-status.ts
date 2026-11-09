/**
 * The vocabulary the two halves share about a browser login in progress.
 *
 * ## Why it is its own module
 *
 * Both halves need these names and neither owns them: the host writes the
 * outcome into the settings document, the browser half reads it and drives the
 * form the login opens in. A module the two import is the only place the
 * contract can live without one half depending on the other's internals —
 * the same reasoning `../form-request.ts` follows for the credential form.
 *
 * ## What travels, and what does not
 *
 * A login's outcome is a kind and, at most, an account name or a message. No
 * credential ever crosses this channel in either direction: the credential
 * arrives at a loopback socket the host owns, is verified there, and is stored
 * there. The browser half learns only that it worked, and as whom.
 *
 * @module @huaweidevtools/aishell-dsh-client-credentials/login-status
 */

/** Field of this entry's config carrying the last login's outcome. */
export const LOGIN_OUTCOME_FIELD = 'loginOutcome'

/**
 * Header the reachability probe sends, to force a CORS preflight.
 *
 * Any non-safelisted header would do it; this one names why. Declared here
 * because both halves need the same string and neither owns it: the browser
 * half sends it on the loopback fetch, the host's listener must allow it in
 * its preflight answer, and a mismatch between the two is a probe that fails
 * on a route that would actually work — the entry hidden for no reason.
 */
export const PROBE_HEADER = 'x-aishell-probe'

/** How a browser login ended. */
export type LoginOutcome =
  /** The credential verified against IAM and was stored. */
  | { readonly kind: 'succeeded', readonly accountName: string }
  /** It did not, with copy the person can act on. */
  | { readonly kind: 'failed', readonly error: string }

/**
 * Serialize an outcome for the settings document.
 *
 * @param outcome - the outcome, or `undefined` to clear the field.
 * @returns the encoded value, or `''` to clear it.
 */
export function encodeOutcome(outcome: LoginOutcome | undefined): string {
  return outcome === undefined ? '' : JSON.stringify(outcome)
}

/**
 * Read an outcome back out of the document.
 *
 * Anything unreadable reads as no outcome: a corrupt field should show
 * nothing, not a spurious success.
 *
 * @param raw - the stored string, if any.
 * @returns the outcome, or `undefined` when there is none usable.
 */
export function decodeOutcome(raw: string | undefined): LoginOutcome | undefined {
  if (raw === undefined || raw === '') return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return undefined
  }
  if (parsed === null || typeof parsed !== 'object') return undefined
  const candidate = parsed as { kind?: unknown, accountName?: unknown, error?: unknown }
  if (candidate.kind === 'succeeded' && typeof candidate.accountName === 'string') {
    return { kind: 'succeeded', accountName: candidate.accountName }
  }
  if (candidate.kind === 'failed' && typeof candidate.error === 'string') {
    return { kind: 'failed', error: candidate.error }
  }
  return undefined
}
