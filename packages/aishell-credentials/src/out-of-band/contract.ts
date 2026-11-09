/**
 * The aishell-auth contract, as this plugin consumes it.
 *
 * ## What this module is
 *
 * A client for one stateless service that answers a single question: *where
 * should the browser go to sign in, and how does the credential come back?*
 * It stores nothing, holds no credential, and has no user system — the cloud
 * posts the credential straight to the caller.
 *
 * ## Why the contract is read, not hardcoded
 *
 * Every quirk of the cloud's callback is in the response: the listen path, the
 * accepted origins, whether a correlation string exists, what to do with the
 * payload. The service's own README says the point is that the caller "does
 * not need to hardcode anything provider-specific" — so this module hardcodes
 * none of it either. That is what makes a second provider a config change here
 * rather than a rewrite, and it is why the types below mirror the wire exactly
 * instead of modelling what Huawei happens to do today.
 *
 * ## Why field mapping is schema-driven
 *
 * `credential_schema` names the payload fields per provider. Mapping by those
 * names rather than by literal keys means a provider that calls its fields
 * something else still lands in the right store slots, and a provider that
 * renames one is a server-side change the caller follows for free.
 *
 * ## No exception, after all
 *
 * Private Network Access is in the contract as
 * `requires_private_network_access`: a browser on a public origin reaching
 * loopback sends a preflight carrying `Access-Control-Request-Private-Network`,
 * and a response without the matching allow header makes it drop the real
 * request — invisibly, in production only, with no error anywhere. The
 * contract carries that fact now, so this module hardcodes nothing about it.
 * See `./listener.ts` for how the flag and the browser's own request header
 * are combined.
 *
 * @module @huaweidevtools/aishell-dsh-client-credentials/out-of-band/contract
 */

/**
 * Base URL of the login-dispatch service.
 *
 * A constant rather than a setting: it identifies one deployment of a shared
 * service, the same way a cloud endpoint would, and every caller of this
 * plugin in an organisation points at the same one. A deployment that needs a
 * different address is a code change here, which is the honest representation
 * — this is not something an end user picks.
 */
export const AUTH_SERVICE_BASE = 'https://public.aishell.openbuildlab.com'

/** How the credential reaches the caller. */
export type Delivery =
  /** The cloud posts the credential directly to the caller's listener. */
  | 'out_of_band'
  /** The cloud posts a code; the caller exchanges it for the credential. */
  | 'brokered'

/** What a callback carries that the caller can use to recognise its own request. */
export type Correlation =
  /** Nothing — the caller can only match on port and timing. */
  | 'none'
  /** A `code`, which pairs with a PKCE verifier for a strong binding. */
  | 'pkce'

/**
 * Where to listen and how to answer — the provider's quirks, resolved.
 *
 * Every field here replaces something the caller would otherwise have to know
 * about a specific cloud.
 */
export interface CallbackPlan {
  /** Address to listen on, e.g. `127.0.0.1:39821`. */
  readonly address: string
  /** Path the cloud posts to — whose own name and shape are the provider's business. */
  readonly path: string
  /** HTTP method of the post. */
  readonly method: string
  /** When set, the post carries this Content-Type and so triggers a preflight. */
  readonly content_type?: string
  /**
   * Origins that must be accepted for the callback, exactly.
   *
   * A list because one cloud can post from several (a main site, a regional
   * variant, an embedding host). A response header takes a single value, so
   * the listener echoes the one that matched. Empty means no CORS applies —
   * a top-level navigation rather than a cross-origin fetch.
   */
  readonly allow_origins?: readonly string[]
  /**
   * Whether the cloud's post arrives as a private-network request.
   *
   * When true the preflight carries `Access-Control-Request-Private-Network`
   * and the response must carry the matching allow header, or the browser
   * drops the real request. Absent and false are equivalent — an older service
   * that does not report it, and a provider whose callback is not cross-origin
   * to a public page, both land there.
   */
  readonly requires_private_network_access?: boolean
  /** What the callback carries for correlation; `none` means it carries nothing. */
  readonly correlation: Correlation
}

/** One provider the service can dispatch a login for. */
export interface ProviderInfo {
  readonly id: string
  readonly display_name: string
  readonly delivery: Delivery
  /** Name of the credential this provider issues, e.g. `ak_sk_sts`. */
  readonly credential_type: string
  /**
   * Payload field name to type, for the credential the cloud will post.
   *
   * This is the mapping the caller applies — the reason no field name appears
   * as a literal elsewhere in this plugin.
   */
  readonly credential_schema: Readonly<Record<string, string>>
}

/** Where the browser goes, and how the credential comes back. */
export interface LoginTarget {
  readonly provider: string
  readonly delivery: Delivery
  /** URL to open in the browser. */
  readonly login_url: string
  readonly callback: CallbackPlan
  /** Seconds the login remains valid, after which the callback will not arrive. */
  readonly expires_in: number
}

/**
 * A response this client could not use.
 *
 * Its own type so a caller can tell "the service said no" from "the network
 * failed": both mean the browser-login entry is unavailable, but only the
 * first is worth logging with the service's own words.
 */
export class AuthContractError extends Error {
  override readonly name = 'AuthContractError'
}

/**
 * Read one JSON response, failing with the service's own message.
 *
 * The service answers errors as `{ error_code, error_msg }` — a shape shared
 * across this family of services — and the message is worth surfacing: it
 * distinguishes "this provider does not exist" from "this redirect_uri is not
 * acceptable", which are different problems with the same status class.
 *
 * @param response - the response to read.
 * @param what - what was being requested, for the fallback message.
 * @throws {AuthContractError} on a non-2xx status or an unreadable body.
 */
async function readJson<T>(response: Response, what: string): Promise<T> {
  if (!response.ok) {
    let detail = `HTTP ${String(response.status)}`
    try {
      const body = await response.json() as { error_msg?: unknown, error_code?: unknown }
      const message = typeof body.error_msg === 'string' && body.error_msg !== ''
        ? body.error_msg
        : undefined
      const code = typeof body.error_code === 'string' ? body.error_code : undefined
      if (message !== undefined) detail = code === undefined ? message : `${message} (${code})`
    } catch {
      // A non-JSON error body says nothing usable; the status stands alone.
    }
    throw new AuthContractError(`${what} failed: ${detail}`)
  }
  try {
    return await response.json() as T
  } catch {
    throw new AuthContractError(`${what} returned a body that is not JSON.`)
  }
}

/** Narrow the service's answer to the shape this client is willing to act on. */
function assertLoginTarget(value: LoginTarget): LoginTarget {
  const callback = value.callback
  if (typeof value.login_url !== 'string' || value.login_url === '') {
    throw new AuthContractError('The login service returned no login_url.')
  }
  if (callback === null || typeof callback !== 'object') {
    throw new AuthContractError('The login service returned no callback plan.')
  }
  if (typeof callback.address !== 'string' || typeof callback.path !== 'string') {
    throw new AuthContractError('The login service returned an incomplete callback plan.')
  }
  // A delivery this client cannot run is refused here rather than at the
  // listener, where it would surface as a timeout with no explanation. Only
  // `out_of_band` is implemented; `brokered` would need the exchange step, and
  // no provider offers it yet.
  if (value.delivery !== 'out_of_band') {
    throw new AuthContractError(
      `The login service offered delivery "${value.delivery}", which this plugin cannot complete.`,
    )
  }
  return value}

/** Services the client needs, injected so its behavior is testable without a network. */
export interface ContractDeps {
  /** Performs the request; defaults to the ambient `fetch`. */
  readonly fetch?: typeof fetch
  /** Service base URL; defaults to {@link AUTH_SERVICE_BASE}. */
  readonly base?: string
}

/**
 * List the providers the service can dispatch for.
 *
 * @param deps - transport overrides.
 * @returns every provider, in the service's order.
 * @throws {AuthContractError} when the service is unreachable or answers unusably.
 */
export async function listProviders(deps: ContractDeps = {}): Promise<readonly ProviderInfo[]> {
  const doFetch = deps.fetch ?? fetch
  const base = deps.base ?? AUTH_SERVICE_BASE
  let response: Response
  try {
    response = await doFetch(`${base}/v1/providers`)
  } catch (error) {
    // A transport failure is the ordinary "this machine has no route to the
    // service" case, and it must read as that rather than as a malformed body.
    throw new AuthContractError(
      `Could not reach the login service at ${base}: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
  const body = await readJson<{ providers?: readonly ProviderInfo[] }>(response, 'Listing login providers')
  return body.providers ?? []
}

/**
 * Find one provider by id.
 *
 * @param providerId - the provider to look for.
 * @param deps - transport overrides.
 * @returns the provider, or `undefined` when the service does not offer it.
 * @throws {AuthContractError} when the service is unreachable or answers unusably.
 */
export async function findProvider(
  providerId: string,
  deps: ContractDeps = {},
): Promise<ProviderInfo | undefined> {
  const providers = await listProviders(deps)
  return providers.find(provider => provider.id === providerId)
}

/**
 * Ask where the browser should go for one provider.
 *
 * @param providerId - the provider to sign in with.
 * @param redirectUri - the address the caller will listen on. Its host must be
 *   loopback and its port explicit; a provider may reject anything else, and
 *   the service reports that as a `400` rather than silently adjusting it.
 * @param deps - transport overrides.
 * @returns the browser URL and the callback plan to honour.
 * @throws {AuthContractError} when the service is unreachable, rejects the
 *   redirect URI, or answers unusably.
 */
export async function requestLogin(
  providerId: string,
  redirectUri: string,
  deps: ContractDeps = {},
): Promise<LoginTarget> {
  const doFetch = deps.fetch ?? fetch
  const base = deps.base ?? AUTH_SERVICE_BASE
  const url = `${base}/v1/login?provider=${encodeURIComponent(providerId)}`
    + `&redirect_uri=${encodeURIComponent(redirectUri)}`
  let response: Response
  try {
    response = await doFetch(url)
  } catch (error) {
    throw new AuthContractError(
      `Could not reach the login service at ${base}: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
  return assertLoginTarget(
    await readJson<LoginTarget>(response, `Starting a ${providerId} login`),
  )
}

/** Field names this plugin's store understands, as they appear in a `credential_schema`. */
export interface MappedCredential {
  readonly accessKeyId: string
  readonly secretAccessKey: string
  /** Present only when the provider issued one. */
  readonly securityToken?: string
}

/**
 * Apply a provider's `credential_schema` to a callback payload.
 *
 * The schema maps a payload key to a type; this pulls the string values out
 * under the names the store uses. A payload missing a field the schema
 * promises is a malformed callback, not a credential — returning `undefined`
 * lets the caller treat it as "nothing arrived" instead of storing half a
 * pair, which is the failure the store's single-record design exists to
 * prevent.
 *
 * A `securitytoken` absent from both the schema and the payload is ordinary —
 * a permanent key has none — so it is optional even though the schema lists
 * it.
 *
 * @param schema - the provider's `credential_schema`.
 * @param payload - the decoded callback body.
 * @returns the credential under this plugin's names, or `undefined` when the
 *   payload does not satisfy the schema.
 */
export function mapCredential(
  schema: Readonly<Record<string, string>>,
  payload: Readonly<Record<string, unknown>>,
): MappedCredential | undefined {
  /** The schema key whose name marks it as each slot; providers differ, the roles do not. */
  const keyFor = (candidates: readonly string[]): string | undefined =>
    Object.keys(schema).find(key => candidates.includes(key.replace(/[_-]/g, '').toLowerCase()))

  const accessKey = keyFor(['access', 'accesskey', 'accesskeyid', 'ak'])
  const secretKey = keyFor(['secret', 'secretkey', 'secretaccesskey', 'sk'])
  const token = keyFor(['securitytoken', 'token', 'sessiontoken'])

  if (accessKey === undefined || secretKey === undefined) return undefined
  const ak = payload[accessKey]
  const sk = payload[secretKey]
  if (typeof ak !== 'string' || ak === '' || typeof sk !== 'string' || sk === '') return undefined

  const rawToken = token === undefined ? undefined : payload[token]
  return {
    accessKeyId: ak,
    secretAccessKey: sk,
    // An empty token is a provider sending a field it does not use; storing it
    // as `''` would sign a third header the gateway then rejects.
    ...(typeof rawToken === 'string' && rawToken !== '' ? { securityToken: rawToken } : {}),
  }
}
