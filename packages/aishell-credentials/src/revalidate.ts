/**
 * Re-checking a stored credential against IAM, and acting on the answer.
 *
 * ## What this governs
 *
 * A stored pair can stop working without anything about it changing: a
 * temporary credential's token expires, a permanent key is deleted in the
 * console. Nothing in the store moves, so a reader of the store keeps reporting
 * a credential that IAM would now refuse.
 *
 * The question "is this still usable?" is therefore asked of IAM, and its three
 * possible answers are not interchangeable — which is what this module exists
 * to keep straight. The same classification serves the background check and the
 * `auth` tool, so a chip that reads "signed in" and a tool that reports "no
 * credentials" cannot be the same moment seen twice.
 *
 * ## The three answers, and what each may do to the store
 *
 *   - **Accepted.** Nothing to change; the account name is refreshed.
 *   - **Refused** (401/403). The pair cannot be used again, so it is discarded
 *     and the interface returns to "not configured". Re-entering the same bytes
 *     cannot help, which is why this is the only case that clears.
 *   - **Unreachable** (status 0, or 5xx). Says nothing about the credential.
 *     Clearing here would log a person out because their network blipped.
 *
 * That third case is the one a poll must not turn into a logout, and the one a
 * background loop makes easy to get wrong: a laptop waking from sleep, an IAM
 * outage, a proxy dropping the call all look like "the credential is bad" if
 * the only question asked is whether verification succeeded.
 *
 * @module @huaweidevtools/aishell-dsh-client-credentials/revalidate
 */

import type { SignCredentials } from '@huaweidevtools/aishell-dsh-credentials-store/signer'

/** What one verification said about the credential, in the terms callers act on. */
export type Validity =
  /** IAM accepted the pair. */
  | { readonly kind: 'valid', readonly accountName: string }
  /** IAM refused the pair itself; it cannot be used again. */
  | { readonly kind: 'refused', readonly message: string }
  /** The question never reached IAM, or IAM failed to answer. The pair may be fine. */
  | { readonly kind: 'unreachable', readonly message: string }

/** Collaborators one revalidation runs against; injected so it is testable. */
export interface RevalidateDeps {
  /** Verifies against IAM; resolves the account name, or rejects with a status-carrying error. */
  readonly verify: (credential: SignCredentials) => Promise<string>
  /**
   * Whether a verify failure means IAM refused the credential.
   *
   * Asked of the error rather than re-derived from a message: the classification
   * lives in one place (the host's `isRejection`), and a second copy would
   * disagree with it the first time the wording changed.
   */
  readonly isRejection: (error: unknown) => boolean
  /** Removes the stored pair and announces the change. Called only when refused. */
  readonly discard: () => void
}

/**
 * Verify one stored pair, and discard it if IAM refused it.
 *
 * The discard is inside this function on purpose. Every caller that verifies a
 * stored pair has to make the same judgement about a refusal, and the one that
 * forgets leaves a credential the interface keeps advertising. Making it part
 * of "verify" means a caller cannot skip it by not knowing about it.
 *
 * @param credential - the pair to verify.
 * @param deps - verifier, refusal test, and the discard action.
 * @returns what the check found, in terms the caller can act on.
 */
export async function revalidate(
  credential: SignCredentials,
  deps: RevalidateDeps,
): Promise<Validity> {
  try {
    return { kind: 'valid', accountName: await deps.verify(credential) }
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error)
    if (!deps.isRejection(error)) return { kind: 'unreachable', message }
    deps.discard()
    return { kind: 'refused', message }
  }
}

/**
 * How long to wait before the next background check.
 *
 * ## Why the interval is a function
 *
 * A fixed period is wrong in both directions. Checking a credential that has
 * never been stored verifies nothing; checking while the page is hidden spends
 * IAM quota to tell nobody anything; and retrying an IAM outage every minute
 * turns one outage into a steady stream of failing calls.
 *
 * ## The ladder
 *
 *   - Nothing stored → no check. There is no credential to ask about, and the
 *     form is the only way one arrives.
 *   - Page hidden → no check. The person is not looking; a status that changed
 *     while they were away is picked up on the next visible tick, and the
 *     visible tick is what the interface is honest about.
 *   - Last check unreachable → back off, doubling to a ceiling. This is the
 *     case that must not become a retry storm: the credential is probably fine
 *     and IAM is not.
 *   - Otherwise → the ordinary period.
 *
 * Returns `undefined` for "do not schedule another check", which is distinct
 * from a very long delay: a hidden page or an empty store stops the loop, and
 * something else (a visibility change, a save) is what starts it again.
 *
 * @param input - current state, as the caller observes it.
 * @returns milliseconds until the next check, or `undefined` to stop.
 */
export function nextCheckDelay(input: {
  readonly hasCredential: boolean
  readonly visible: boolean
  readonly consecutiveUnreachable: number
  readonly periodMs: number
}): number | undefined {
  if (!input.hasCredential) return undefined
  if (!input.visible) return undefined
  if (input.consecutiveUnreachable === 0) return input.periodMs
  // Doubling from the ordinary period, capped so a long outage is still noticed
  // within minutes of IAM recovering rather than hours.
  const backoff = input.periodMs * 2 ** Math.min(input.consecutiveUnreachable, BACKOFF_CAP_STEPS)
  return Math.min(backoff, BACKOFF_CEILING_MS)
}

/** How many doublings the backoff may apply. */
const BACKOFF_CAP_STEPS = 3

/** Slowest the backoff goes. */
const BACKOFF_CEILING_MS = 300_000