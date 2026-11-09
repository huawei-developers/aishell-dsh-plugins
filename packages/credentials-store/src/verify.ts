/**
 * Huawei Cloud IAM credential verification — one implementation, shared.
 *
 * ## Why one implementation
 *
 * Several packages need to answer "are these credentials valid?": the
 * credential form before it saves, and any tool about to sign with them. Each
 * answer has to agree with every other, or a credential passes one check and
 * fails the next with a message that points at the wrong thing. One
 * implementation, shaped for storage rather than for the form, gives every
 * caller the same verdict in the same shape.
 *
 * ## Why `/v3/projects` is the endpoint
 *
 * It is a superset of the domains call:
 *
 *   - A 200 proves the AK/SK (and STS token) work, signed exactly the way every
 *     other call is.
 *   - Each project carries `domain_id`, which **is** the account id (Huawei
 *     Cloud's "domain" and "account" are the same object).
 *   - Each project's `name` is a region name, so a caller that needs a
 *     `project_id` for a region-scoped API has it without a second request.
 *
 * The account *name* is the one thing projects does not carry, so it is read
 * from `/v3/auth/domains` **best-effort** — some AK/SK scopes do not grant it,
 * and a missing name is diagnostic-only. A failure there never fails
 * verification.
 *
 * ## Region semantics, which surprise people
 *
 * IAM is a global service. The region in the URL only routes to a regional
 * replica; it does not scope the result. So a wrong region still answers 200
 * with the same account, and the real mismatch surfaces at the first
 * region-scoped call. Verification therefore validates the credentials and
 * **not** the region — conflating them would report "invalid credentials" for
 * a typo'd region, sending the person to check the wrong thing.
 *
 * ## Result shape
 *
 * A discriminated union rather than a throw: a rejected credential is an
 * expected outcome of asking someone for credentials, not an exception. The
 * caller decides whether to show, log or retry it.
 *
 * @module @huaweidevtools/aishell-dsh-credentials-store/verify
 */

import { sign, type SignCredentials } from './signer.ts'

/** One project visible to the credentials; its `name` is a region name. */
export interface VerifiedProject {
  /** The `project_id` a region-scoped API takes. */
  readonly id: string
  /** The project name — the region name, e.g. `cn-north-4`. */
  readonly name: string
  readonly description?: string
}

/** The account the credentials belong to. */
export interface VerifiedAccount {
  /** The account id, equal to IAM's `domain_id`. */
  readonly accountId: string
  /** The account (domain) name; falls back to {@link accountId} when unreadable. */
  readonly name: string
  /**
   * Every project visible to these credentials.
   *
   * More than one project may share a region name (enterprise projects), which
   * is why this is not reduced to a region→project map: picking one would be a
   * deployment decision this module has no basis for.
   */
  readonly projects: readonly VerifiedProject[]
}

/** A successful verification. */
export interface VerifyOk {
  readonly ok: true
  readonly account: VerifiedAccount
  /** The region the call was routed through; see the module note — not verified. */
  readonly region: string
  /** Whether the credentials were temporary (STS). */
  readonly sts: boolean
}

/** A failed verification. */
export interface VerifyFailed {
  readonly ok: false
  /** HTTP status from IAM, or `0` for a network/signing failure. */
  readonly status: number
  /** A sentence the person or model can act on. */
  readonly message: string
}

/** The outcome of one verification. */
export type VerifyResult = VerifyOk | VerifyFailed

/** Options for {@link verifyCredentials}. */
export interface VerifyOptions {
  /** Region used to route the call. Does not scope the result; see the module note. */
  readonly region: string
  /** Fetch implementation; defaults to the global. Injected so tests need no network. */
  readonly fetchImpl?: typeof fetch
  /** Per-request timeout in milliseconds; defaults to 15 s. */
  readonly timeoutMs?: number
}

/** Default per-request timeout; IAM answers in well under a second when healthy. */
const DEFAULT_TIMEOUT_MS = 15_000

/** Narrow a possibly-absent value for `filter`. */
function defined<T>(value: T | undefined): value is T {
  return value !== undefined
}

/** IAM hostname for a region (regional replica of a global service). */
function iamUrl(region: string): string {
  const host = /^\d+\.\d+\.\d+\.\d+$/.test(region) || region === 'global'
    ? 'iam.myhuaweicloud.com'
    : `iam.${region}.myhuaweicloud.com`
  return `https://${host}`
}

/**
 * Sign and GET one IAM path, returning the status and body.
 *
 * @param base - IAM origin.
 * @param path - the request path.
 * @param credentials - the pair to sign with.
 * @param options - fetch implementation and timeout.
 */
async function signedGet(
  base: string,
  path: string,
  credentials: SignCredentials,
  options: VerifyOptions,
): Promise<{ status: number, body: string }> {
  const fetchImpl = options.fetchImpl ?? fetch
  const url = new URL(`${base}${path}`)
  const headers = sign('GET', url.host, url.pathname, {}, '', credentials)
  const signal = AbortSignal.timeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS)
  const response = await fetchImpl(url, {
    method: 'GET',
    headers: {
      host: headers.host,
      'x-sdk-date': headers['x-sdk-date'],
      Authorization: headers.Authorization,
      ...(headers['x-security-token'] === undefined
        ? {}
        : { 'x-security-token': headers['x-security-token'] }),
    },
    signal,
  })
  return { status: response.status, body: await response.text() }
}

/**
 * Verify a credential pair against Huawei Cloud IAM.
 *
 * The pair is signed exactly as every other request is, so a 200 proves the
 * same thing a successful tool call would prove — no separate verification
 * scheme that could drift from the one that actually runs.
 *
 * @param credentials - the AK/SK (and optional STS token) to verify.
 * @param options - region and transport details.
 * @returns the account on success, or a failure naming what IAM said.
 */
export async function verifyCredentials(
  credentials: SignCredentials,
  options: VerifyOptions,
): Promise<VerifyResult> {
  const base = iamUrl(options.region)

  let status: number
  let body: string
  try {
    ({ status, body } = await signedGet(base, '/v3/projects', credentials, options))
  } catch (error) {
    return {
      ok: false,
      status: 0,
      message: `Could not reach Huawei Cloud IAM: ${error instanceof Error ? error.message : String(error)}`,
    }
  }

  if (status !== 200) {
    return { ok: false, status, message: describeIamFailure(status, body) }
  }

  const parsedProjects = parseProjects(body)
  if (parsedProjects === undefined) {
    return { ok: false, status, message: 'Huawei Cloud IAM answered with a body that is not JSON.' }
  }

  const first = parsedProjects[0]
  if (first === undefined) {
    // Authenticated but sees no projects. IAM is global, so this is not a
    // region problem: the AK/SK lacks IAM read scope, or belongs to a
    // sub-account whose parent has not granted project membership. Terraform
    // needs a project, so this is a failure rather than an empty success.
    return {
      ok: false,
      status,
      message:
        'The credentials are valid but no project is visible to them. Confirm the AK/SK may '
        + 'read IAM, or ask the main account to grant project membership. '
        + '(This is unrelated to the region — IAM is a global service.)',
    }
  }

  const accountId = first.domainId
  if (accountId === undefined) {
    return { ok: false, status, message: 'Huawei Cloud IAM returned no domain_id, so the account is unknown.' }
  }

  // Every project carries the domain it belongs to, and they must agree: one
  // Set of credentials is one account. A body mixing two would mean an
  // aggregating proxy or a partial failover answered, and taking `first` then
  // would silently report an account chosen by response order. The projects
  // would also be unusable — `project_id` values from two accounts cannot be
  // mixed in one deployment — so this is a failure, not a warning.
  const domains = new Set(parsedProjects.map(project => project.domainId).filter(defined))
  if (domains.size > 1) {
    return {
      ok: false,
      status,
      message:
        'Huawei Cloud IAM returned projects belonging to more than one account '
        + `(${[...domains].join(', ')}). These credentials cannot be used together; `
        + 'sign in with an account-scoped AK/SK.',
    }
  }

  const name = await readAccountName(base, accountId, credentials, options) ?? accountId

  return {
    ok: true,
    account: { accountId, name, projects: parsedProjects },
    region: options.region,
    sts: credentials.securityToken !== undefined,
  }
}

/**
 * Parse `/v3/projects` into the project list.
 *
 * @returns the projects (possibly empty), or `undefined` when the body is not
 *   JSON at all — a different failure from "valid JSON, no projects".
 */
function parseProjects(body: string): Array<VerifiedProject & { readonly domainId?: string }> | undefined {
  let parsed: unknown
  try {
    parsed = JSON.parse(body)
  } catch {
    return undefined
  }
  const raw = (parsed as { projects?: unknown } | null)?.projects
  if (!Array.isArray(raw)) return []

  const projects: Array<VerifiedProject & { readonly domainId?: string }> = []
  for (const entry of raw) {
    const project = entry as Record<string, unknown> | null
    if (project === null || typeof project !== 'object') continue
    if (typeof project.id !== 'string' || project.id === '') continue
    projects.push({
      id: project.id,
      name: typeof project.name === 'string' ? project.name : '',
      ...(typeof project.description === 'string' && project.description !== ''
        ? { description: project.description }
        : {}),
      // Kept beside the public fields because the caller derives the account id
      // from it without a second pass over the raw body.
      ...(typeof project.domain_id === 'string' && project.domain_id !== ''
        ? { domainId: project.domain_id }
        : {}),
    })
  }
  return projects
}

/**
 * Read the account (domain) name, best-effort.
 *
 * @returns the name, or `undefined` — never an error. Some AK/SK scopes do not
 *   grant `/v3/auth/domains`, and the account name is diagnostic only.
 */
async function readAccountName(
  base: string,
  accountId: string,
  credentials: SignCredentials,
  options: VerifyOptions,
): Promise<string | undefined> {
  let status: number
  let body: string
  try {
    ({ status, body } = await signedGet(base, '/v3/auth/domains', credentials, options))
  } catch {
    return undefined
  }
  if (status !== 200) return undefined
  try {
    const parsed = JSON.parse(body) as { domains?: Array<{ id?: unknown, name?: unknown }> }
    const match = parsed.domains?.find(domain => domain.id === accountId)
    return typeof match?.name === 'string' && match.name !== '' ? match.name : undefined
  } catch {
    return undefined
  }
}

/**
 * Render an IAM rejection into one actionable sentence.
 *
 * @param status - the HTTP status.
 * @param body - the response body, which may carry Huawei's own error text.
 */
function describeIamFailure(status: number, body: string): string {
  try {
    const parsed = JSON.parse(body) as { error_msg?: unknown, error_code?: unknown, message?: unknown }
    const detail = typeof parsed.error_msg === 'string'
      ? parsed.error_msg
      : typeof parsed.message === 'string' ? parsed.message : undefined
    if (detail !== undefined) {
      const code = typeof parsed.error_code === 'string' ? `, ${parsed.error_code}` : ''
      return `Huawei Cloud rejected the credentials (HTTP ${status}${code}): ${detail}`
    }
  } catch {
    // Non-JSON body — an ingress page or a proxy error; nothing to read.
  }
  if (status === 401) {
    return 'Huawei Cloud rejected the credentials (HTTP 401): the Access Key, Secret Key, '
      + 'or Security Token was refused.'
  }
  if (status === 403) {
    return 'The credentials are valid but may not read IAM (HTTP 403). '
      + 'Confirm the Access Key has IAM read permission.'
  }
  return `Huawei Cloud IAM failed with HTTP ${status}: ${body.slice(0, 200)}`
}