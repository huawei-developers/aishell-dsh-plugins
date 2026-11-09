/**
 * Reading the operator's Huawei Cloud credentials for control-plane requests.
 *
 * The read is delegated to `credentials-store/accounts`, the one place the
 * account names and the pairing rule live. Every plugin in this set that signs
 * with the same key pair goes through it — this module, the LLM adapter, the
 * credential form's Host route and the ops tools — so they cannot disagree
 * about which keyring entries are the credentials, or about what "half a pair"
 * means.
 *
 * Those names are a persistence contract: a second copy of them does not fail a
 * build, it surfaces as one plugin working while another reports "not
 * authenticated" on a machine where the operator has stored exactly one pair.
 * One shared definition is what rules that out.
 *
 * @module @huaweidevtools/aishell-dsh-e2b/credentials
 */

import { createCredentialsStore, type CredentialsStore } from '@huaweidevtools/aishell-dsh-credentials-store'
import type { SignCredentials } from '@huaweidevtools/aishell-dsh-credentials-store/signer'
import { readStoredPair } from '@huaweidevtools/aishell-dsh-credentials-store/accounts'

/**
 * Open a credential store.
 *
 * Takes no options: the service name is fixed in the store package, because a
 * per-plugin choice of namespace is how a writer and a reader end up looking at
 * different stores.
 */
export function openCredentialStore(): CredentialsStore {
  return createCredentialsStore()
}

/**
 * Read the current credentials.
 *
 * AK and SK are read as a pair: half a pair reads as no credentials rather
 * than an error, so a partially-configured machine gets the "authenticate
 * first" message instead of a signing failure with no remedy. The
 * SecurityToken is optional and is omitted from the object entirely when
 * absent — an empty string would sign as a third header the gateway then
 * rejects.
 *
 * Called per request, never captured: that is what makes a credential saved
 * from the credential form apply to the next call.
 *
 * @param store - the credential store to read.
 * @returns the credentials, or `undefined` when the pair is incomplete.
 */
export function readCredentials(store: CredentialsStore): SignCredentials | undefined {
  return readStoredPair(store)
}