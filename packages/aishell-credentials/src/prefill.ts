/**
 * Credential prefill from the environment.
 *
 * ## What this is for
 *
 * A machine that already carries `HW_ACCESS_KEY`, `HW_SECRET_KEY` and
 * `HW_SECURITY_TOKEN` in its environment has the credentials; the person just
 * has to move them into the store. Typing three values that are already on the
 * machine is work nobody should do, so the form opens with them filled in.
 *
 * ## Why the values come from the host
 *
 * The browser half cannot read `process.env` — it is browser code, and the
 * environment it would see is not the host's. So the host reads the variables
 * and serves them over a route the form calls before it renders its fields.
 *
 * ## Why that is acceptable here
 *
 * The values travel from the host to the page it is serving, over the same
 * authenticated channel and the same origin as the credential route the form
 * already posts to. Nothing new is exposed: a page that could read this route
 * could also submit that form.
 *
 * They are **not** written to the settings document, the session, or a log —
 * the route is the whole journey, and it is called once per form open.
 *
 * ## Why it returns nothing rather than a partial set
 *
 * A form filled with an access key and no secret key looks broken. Either the
 * environment carries a usable pair, or the form starts empty and the person
 * enters what they have. The token is separate: it is optional, and a lone
 * token with no pair is dropped for the same reason.
 *
 * ## Why the form says so
 *
 * The person did not type these values. Saying where they came from is what
 * lets them decide whether to trust them — a credential silently appearing in
 * a field is worse than an empty one.
 *
 * @module @huaweidevtools/aishell-dsh-client-credentials/prefill
 */

/** Route the form reads prefills from. */
export const PREFILL_PATH = '/api/aishell/credentials/prefill'

/** Variables read, in the order the form's fields appear. */
const ACCESS_KEY_ENV = 'HW_ACCESS_KEY'
const SECRET_KEY_ENV = 'HW_SECRET_KEY'
const SECURITY_TOKEN_ENV = 'HW_SECURITY_TOKEN'

/**
 * A credential set read out of the environment.
 *
 * All fields optional, because "nothing to prefill" is the ordinary answer —
 * most machines have no credential in their environment. The form treats an
 * empty object as empty fields, which is exactly its behaviour without this
 * feature at all.
 */
export interface CredentialPrefill {
  readonly accessKeyId?: string
  readonly secretAccessKey?: string
  /** Present only when the environment carries one. */
  readonly securityToken?: string
}

/**
 * Read an environment for a usable credential set.
 *
 * Pure, and the environment is a parameter: this package compiles without Node
 * type definitions (the browser half is most of it), so `process` is not in
 * scope and the caller supplies what to read.
 *
 * ## What these values do, and do not, do
 *
 * They fill the form's fields. The form still opens, every field is still
 * editable, and submitting or cancelling still works the way it always did —
 * the person saves the step of copying three values out of their shell, and
 * nothing else. In particular nothing is stored on their behalf: a prefill is a
 * starting point, not a credential.
 *
 * @param env - the environment to read.
 * @returns the pair (and token, when present), or `undefined` when either half
 *   of the pair is missing.
 */
export function readEnvPrefill(
  env: Record<string, string | undefined>,
): CredentialPrefill | undefined {
  const ak = env[ACCESS_KEY_ENV]
  const sk = env[SECRET_KEY_ENV]
  // Half a pair is no pair: filling one field and leaving the other empty
  // would submit an incomplete credential, and the form would say only that
  // the save failed.
  if (ak === undefined || ak === '' || sk === undefined || sk === '') return undefined
  const token = env[SECURITY_TOKEN_ENV]
  return {
    accessKeyId: ak,
    secretAccessKey: sk,
    ...(token === undefined || token === '' ? {} : { securityToken: token }),
  }
}