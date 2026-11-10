/**
 * Credentials for this plugin's tools.
 *
 * The AK/SK pair comes from the one store AI Shell has — the `aishell-dsh-plugins`
 * keyring the credential form writes — read through `readStoredPair`, the same
 * function `aishell-llm`, `aishell-e2b` and `aishell-credentials` use. There is
 * no adapter and no mirror here: a rotation in the form applies to the very
 * next tool call, and a clear means what it says.
 *
 * One thing the shared store deliberately does not know, and this module
 * supplies: **the account identity**. The store holds secrets and nothing
 * else, so `{account_id, name}` is resolved from IAM on demand and cached for
 * this process.
 *
 * The region is not one of them. It does not enter the signature — verified:
 * two regions produce byte-identical Authorization headers — so it is not a
 * property of the account. It belongs to each RESOURCE in a plan, and
 * {@link configuredRegion} exposes only the fallback an operator may have set.
 *
 * @module @huaweidevtools/aishell-dsh-deploy/credentials
 */

import type { CredentialsStore } from '@huaweidevtools/aishell-dsh-credentials-store'
import { readStoredPair } from '@huaweidevtools/aishell-dsh-credentials-store/accounts'
import { verifyCredentials } from '@huaweidevtools/aishell-dsh-credentials-store/verify'

/**
 * One credential set, as the signing paths here take it.
 *
 * AK, SK and the optional STS token — and nothing else. `region` is
 * deliberately NOT here: it does not enter the signature (verified — two
 * regions produce byte-identical Authorization headers), so it is not a
 * property of the account. It is a property of each RESOURCE, read from the
 * plan, and every caller that needs one says where it came from.
 *
 * Keeping it out is what lets one deployment span several regions: a
 * deployment-wide region would have to be right for every resource at once.
 */
export interface Credentials {
  readonly ak: string
  readonly sk: string
  /** Present only for STS (temporary) credentials. */
  readonly securityToken?: string
}

/**
 * The account identity resolved from IAM.
 *
 * Diagnostics only — it names the account in the deployment snapshot and is
 * used as an RMS path parameter.
 */
export interface AccountIdentity {
  readonly account_id: string
  readonly account_name: string
}

/**
 * How this module reaches the host: the plugin's credential store.
 *
 * ## Why `region` is optional, and why there is no default
 *
 * A region is not an account property — it does not enter the signature — so
 * it cannot come from the store. It comes from each resource's plan.
 *
 * This field is the fallback for a plan that names none, and it exists only
 * because terraform has one of its own (`HW_REGION_NAME`). The two must be the
 * same value: if terraform were told one region while pricing assumed another,
 * the quote would describe a price list column the deployment never bills
 * against. So the value is set by an operator in the plugin config, or not at
 * all — a built-in default would be that guess, with nothing on screen to
 * contradict it.
 *
 * When it is absent, a resource whose plan names no region is reported as
 * unpriced rather than priced against a guess.
 */
export interface CredentialSource {
  /** The plugin's credential store; read per call, never captured. */
  readonly store: CredentialsStore
  /** The fallback region an operator configured, if any. */
  readonly region?: string | undefined
  /**
   * Told when IAM refuses the stored credential.
   *
   * A tool call reaching IAM and being refused is the FASTEST evidence this
   * plugin can get that the credential has stopped working — faster than any
   * poll, because it happens exactly when someone is waiting. The owner of the
   * store is the only party that can act on it: it clears the pair and tells
   * the interface, which is what returns the credential card to its
   * not-signed-in state.
   *
   * Not called for a transient failure. `status === 0` and a 5xx mean the
   * question never reached IAM, and clearing on those would log a person out
   * because their network blipped.
   */
  readonly onRejected?: () => void
}

let source: CredentialSource | undefined

/**
 * Bind the credential source. Called once from the plugin's `apply()`.
 *
 * A module-level setter carries a real hazard worth naming: it is
 * process-wide, so two mounts of this plugin in one process would share the
 * last-configured reader. That cannot happen under DSH — a loader row mounts
 * once — and the alternative (threading a reader through 18 tool registrars)
 * would touch every file for a case that does not exist.
 *
 * @param next - the store, and the region an operator configured if any.
 */
export function configureCredentials(next: CredentialSource): void {
  source = next
}

/** The bound source, or an error naming the wiring bug. */
function requireSource(): CredentialSource {
  if (source === undefined) {
    throw new Error(
      'aishell-deploy: credential source not configured — '
      + 'the plugin must call configureCredentials() during activation',
    )
  }
  return source
}

/**
 * Read the current credentials.
 *
 * @returns the AK/SK pair, or `undefined` when it is incomplete.
 */
export function readStoredCredentials(): Credentials | undefined {
  return readStoredPair(requireSource().store)
}

/**
 * The region an operator configured, when one was.
 *
 * Not a credential and not guessed: see {@link CredentialSource.region} for
 * what reads it. A caller that needs a region for one resource takes it from
 * the plan; this is only the fallback for a plan that names none, and for the
 * `HW_REGION_NAME` terraform runs under.
 *
 * Unlike the credential read, an unbound source is not an error here. This
 * answers "was a region configured", and the honest answer for a process that
 * configured none is `undefined` — the same answer as an operator who left it
 * unset. Raising the wiring error instead would turn a supported configuration
 * (no default region) into a startup fault.
 *
 * @returns the configured region, or `undefined`.
 */
export function configuredRegion(): string | undefined {
  const region = source?.region
  return region === '' ? undefined : region
}

/**
 * Load credentials or fail with the remedy the model can act on.
 *
 * The message names the condition and stops: which control opens the credential
 * form is the UI's business, and a tool message naming a button would be a
 * second copy of that path to keep in step.
 *
 * @returns the credentials in hand.
 * @throws when nothing usable is stored.
 */
export async function loadCredentials(): Promise<Credentials> {
  const found = readStoredCredentials()
  if (found === undefined) {
    throw new Error('Not authenticated with Huawei Cloud IAM. Please authenticate, then retry.')
  }
  return found
}

/** Whether a complete AK/SK pair is stored. */
export function hasCredentials(): boolean {
  return readStoredCredentials() !== undefined
}

/**
 * The account identity, resolved from IAM and cached for this process.
 *
 * @see loadAccount for the contract.
 */
let cachedAccount: AccountIdentity | undefined

/**
 * Resolve and cache the account identity.
 *
 * Verification goes through the shared `verifyCredentials`, so "is this
 * account" is answered by the same call the credential form uses — no second
 * notion of validity.
 *
 * It is routed through `'global'`, which is IAM's own spelling for the
 * non-regional endpoint: the question is about the credential, not about any
 * one region, and a regional replica would add a region to a call that does
 * not have one to give.
 *
 * ## Why the failure is thrown rather than folded into `undefined`
 *
 * The two reasons verification can fail call for opposite responses, and
 * folding them into one `undefined` would send the reader to the wrong one. A
 * credential IAM *rejected* is the person's to
 * fix: re-authenticate. A credential IAM never saw — a timeout, DNS, a proxy —
 * is nobody's mistake, and telling the person to re-authenticate sends them to
 * re-enter a credential that was already correct.
 *
 * So the rejected case returns `undefined`, which is the "not authenticated"
 * condition callers already handle, and every other failure throws with IAM's
 * own words. A transient fault then surfaces as a transient fault.
 *
 * @returns the identity, or `undefined` when IAM rejected the credentials.
 *   Also `undefined` when none are stored.
 * @throws when IAM could not be reached, or answered something unusable — the
 *   distinction `status === 0` and a 5xx draw from a rejection.
 */
export async function loadAccount(): Promise<AccountIdentity | undefined> {
  if (cachedAccount !== undefined) return cachedAccount
  const credentials = readStoredCredentials()
  if (credentials === undefined) return undefined
  const result = await verifyCredentials(credentials, { region: 'global' })
  if (!result.ok) {
    // A rejection is about the credential; anything else is about the call.
    // `status === 0` is the module's own marker for "never reached IAM", and a
    // 5xx is IAM failing rather than refusing.
    if (result.status === 0 || result.status >= 500) {
      throw new Error(`${result.message} The stored credentials were not rejected — retry.`)
    }
    // IAM refused the pair: it is not usable for anything this plugin does, and
    // the fastest way to say so is here, at the moment a call found out. The
    // alternative is waiting for a poll that may be minutes away, during which
    // the interface offers a signed-in card that cannot work.
    // `verifyCredentials` already established this is a rejection rather than a
    // transport failure, so no second verification is needed — that is the
    // "verify before discarding" rule, satisfied by the call that got here.
    source?.onRejected?.()
    return undefined
  }
  cachedAccount = {
    account_id: result.account.accountId,
    account_name: result.account.name,
  }
  return cachedAccount
}

/**
 * Drop the cached identity, so the next read resolves it again.
 *
 * Called when the stored credentials change: the account a deployment is
 * recorded under must follow the credentials in hand, not the ones this
 * process started with.
 */
export function forgetAccount(): void {
  cachedAccount = undefined
}