/**
 * Huawei Cloud SDK-HMAC-SHA256 request signing.
 *
 * Signs an HTTP request with AK/SK (and an optional temporary SecurityToken)
 * using the same algorithm as the official Huawei Cloud SDK. Produces the
 * `Authorization`, `x-sdk-date`, and `x-security-token` headers to attach
 * to a `fetch` call.
 *
 * @module @huaweidevtools/aishell-dsh-credentials-store/signer
 */

import crypto from 'node:crypto'

/** Credentials for signing. */
export interface SignCredentials {
  readonly ak: string
  readonly sk: string
  readonly securityToken?: string
}

/** The headers produced by {@link sign}. */
export interface SignedHeaders {
  readonly host: string
  readonly 'x-sdk-date': string
  readonly Authorization: string
  readonly 'x-security-token'?: string
}

function sha256Hex(data: string): string {
  return crypto.createHash('sha256').update(data).digest('hex')
}

function hmacSha256(key: string, data: string): string {
  return crypto.createHmac('sha256', key).update(data).digest('hex')
}

/** RFC 3986 URL-encode a string (unreserved chars stay literal). */
function urlEncode(str: string): string {
  const hex = (c: number): string => '%' + (c < 16 ? '0' : '') + c.toString(16).toUpperCase()
  const noEscape = new Set('ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_.~'.split(''))
  let out = ''
  for (const ch of str) {
    const c = ch.codePointAt(0)!
    if (c < 0x80) {
      out += noEscape.has(ch) ? ch : hex(c)
    } else {
      out += encodeURIComponent(ch)
    }
  }
  return out
}

/** ISO 8601 timestamp in Huawei Cloud format: `20260912T064552Z`. */
function sdkTimestamp(): string {
  // toISOString() returns "2026-09-12T06:45:52.123Z"; strip separators and
  // milliseconds but keep the trailing Z — do NOT append another one.
  return new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+/, '')
}

/**
 * Code-unit comparison — the order the signing specification requires.
 *
 * Exported because it is the part of signing that is checkable without a
 * signature: everything downstream of it is a hash, so a test that compares two
 * signatures cannot tell a correct ordering from a consistently wrong one. See
 * `tests/format.spec.ts`.
 *
 * @param a - one string.
 * @param b - the other.
 * @returns negative, zero or positive in code-unit order.
 */
export function compareCodeUnits(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}

/**
 * Build the canonical query string, sorted by parameter name.
 *
 * ## Why byte order and not `localeCompare`
 *
 * The specification sorts by code point. Locale-aware collation disagrees with
 * it on mixed case: `Zebra` sorts *before* `apple` by code unit and *after* it
 * under the default locale. The signed string would then differ from the one
 * the gateway rebuilds from the same URL, and the request fails to authenticate
 * with nothing in the error naming the sort.
 *
 * Every caller in this repo passes lowercase ASCII parameter names today, which
 * is why this survived; `openapi_request` takes a URL from the model, so mixed
 * case reaches this path from outside.
 *
 * @param query - the query parameters.
 * @returns the canonical string, `k=v&k=v`, with both sides URL-encoded.
 */
export function canonicalQuery(query: Record<string, string>): string {
  return Object.entries(query)
    .sort(([a], [b]) => compareCodeUnits(a, b))
    .map(([k, v]) => `${urlEncode(k)}=${urlEncode(v)}`)
    .join('&')
}

/**
 * Sign an HTTP request with SDK-HMAC-SHA256.
 *
 * @param method - HTTP method (GET, POST, ...).
 * @param host - Host component of the request URL (e.g. `openai.aishell.openbuildlab.com`).
 * @param path - Path component of the request URL (e.g. `/chat/completions`).
 * @param query - Query parameters as a key-value map.
 * @param body - Request body (stringified for hashing; empty string for GET).
 * @param credentials - AK/SK and optional SecurityToken.
 * @returns The headers to attach to the fetch call.
 */
export function sign(
  method: string,
  host: string,
  path: string,
  query: Record<string, string>,
  body: string,
  credentials: SignCredentials,
): SignedHeaders {
  const ts = sdkTimestamp()
  const cqs = canonicalQuery(query)

  // Canonical URI: path segments URL-encoded, joined with /, trailing /
  const curi = '/' + path.split('/').filter(Boolean).map(urlEncode).join('/') + '/'

  // Signed headers
  const hasToken = credentials.securityToken !== undefined
  const signedHeaders = hasToken ? 'host;x-sdk-date;x-security-token' : 'host;x-sdk-date'
  const canonicalHeaders = hasToken
    ? `host:${host}\nx-sdk-date:${ts}\nx-security-token:${credentials.securityToken}\n`
    : `host:${host}\nx-sdk-date:${ts}\n`

  // Payload hash
  const payloadHash = sha256Hex(body)

  // Canonical request
  const canonicalRequest = [method, curi, cqs, canonicalHeaders, signedHeaders, payloadHash].join('\n')

  // String to sign
  const stringToSign = `SDK-HMAC-SHA256\n${ts}\n${sha256Hex(canonicalRequest)}`
  const signature = hmacSha256(credentials.sk, stringToSign)

  const headers: SignedHeaders = {
    host,
    'x-sdk-date': ts,
    Authorization: `SDK-HMAC-SHA256 Access=${credentials.ak}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
    ...(hasToken ? { 'x-security-token': credentials.securityToken } : {}),
  }
  return headers
}
