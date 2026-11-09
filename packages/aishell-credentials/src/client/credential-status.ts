/**
 * Credential vocabulary shared by the surfaces that collect a credential.
 *
 * This module holds the parts of the credential UI that are not one component's
 * presentation: the presence descriptor the Host reports, the verdict its route
 * answers with, and the link to where a credential comes from.
 *
 * ## Why it is its own module
 *
 * Several modules need these — two chips and the form — and none of them owns
 * the other. A shared contract belongs in a file that no consumer is the author
 * of; importing it from one component would make that component's internals a
 * public interface by accident. Same reasoning as `huawei-mark.ts`: the second
 * consumer is when the shared part earns its own module.
 *
 * The paragraph that follows each declaration is the contract the Host half
 * implements; it is stated here because this file is where both sides read it.
 *
 * @module @huaweidevtools/aishell-dsh-client-credentials/client/credential-status
 */

/** Credential presence descriptor (values never cross the wire). */
export interface CredentialStatus {
  readonly hasAccessKey: boolean
  readonly hasSecretKey: boolean
  readonly hasSecurityToken: boolean
  readonly accessKeyIdHint: string
  readonly lastError: string
}

/** Verdict the Host credential route returns for a save or clear. */
export interface SaveVerdict {
  readonly ok: boolean
  /** Verified account name; present only on success. */
  readonly accountName?: string
  /** User-readable failure; present only on rejection. */
  readonly error?: string
}

/**
 * Where a user obtains credentials.
 *
 * API Explorer's page for `CreateTemporaryAccessKeyByToken` — the operation
 * that mints a temporary AK/SK/security-token triple from an IAM token. Linked
 * from both forms because the alternative, a permanent access key created in
 * "My Credentials", has no expiry and cannot be scoped down; steering users to
 * the temporary kind is the point of showing this at all.
 *
 * Not fetched or validated at build time: it is a console URL whose content
 * changes independently of this plugin, and a stale check would be worse than
 * none.
 */
export const CREDENTIAL_URL =
  'https://console.huaweicloud.com/apiexplorer/#/openapi/IAM/doc?version=v3&api=CreateTemporaryAccessKeyByToken'
