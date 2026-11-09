/**
 * Signed HTTP client — single source of truth for sign + fetch.
 *
 * All signed requests to HuaweiCloud APIs from this plugin's tools go through
 * here: openapi_request, list_existing_resources, balance_summary. Keeping the
 * sign+fetch in one place means signing headers, retries, and error handling
 * are maintained once.
 *
 * Credentials come from one of two places:
 *   - Default (no `creds` arg): the plugin's credential store, read per call
 *     via `loadCredentials`.
 *   - Explicit `creds` arg: a caller that already holds the pair.
 *
 * IAM *verification* does not run through here: it lives in the shared
 * `credentials-store/verify` module, owned by `aishell-credentials` alongside
 * the form that collects the pair. This client is the funnel for the cloud
 * calls THIS plugin's tools make, which is what the read-only gate below has to
 * cover.
 *
 * Verified end-to-end against HuaweiCloud APIs:
 *   - IAM GET /v3/projects → 200
 *   - BSS GET /v2/accounts/customer-accounts/balances → 200
 *   - BSS GET /v2/promotions/benefits/coupons → 200
 */

import { signRequest } from "./auth-signer.js";
import { signObsRequest } from "./auth-obs-signer.js";
import { loadCredentials, type Credentials } from "./credentials.js";
import { denyHttp, PermissionRefusalError } from "./permission/gate.js";

/**
 * Whether a host targets OBS (Object Storage Service).
 *
 * OBS endpoints take two forms:
 *   - Global:  obs.<region>.myhuaweicloud.com
 *   - Bucket:  <bucket>.obs.<region>.myhuaweicloud.com  (virtual-hosted style)
 *
 * The rule `startsWith("obs.") || includes(".obs.")` matches both and does not
 * match other services (ecs/rds/bss/iam never contain ".obs.").
 */
function isObsHost(host: string): boolean {
  return host.startsWith("obs.") || host.includes(".obs.");
}

/**
 * The only domains this client will sign a request for.
 *
 * ## Why this is a allowlist and not a warning
 *
 * `openapi_request` takes a URL straight from the model, and every request
 * through it carries an `Authorization` header containing the account's access
 * key id. Without this check, a URL naming any host at all sends that header
 * there — a typo, a hallucinated endpoint, or a prompt-injected instruction is
 * enough to hand the AK to a third party. The same absence of a check lets the
 * request reach anything the process can reach: a loopback service, a cloud
 * metadata endpoint, an internal address.
 *
 * So the domain is checked here, at the one funnel every signed call passes
 * through, rather than being trusted to each caller. A caller that could opt
 * out would be the way this gets bypassed.
 *
 * `myhuaweicloud.com` is the public-cloud API domain; `.myhuaweicloud.com`
 * (with the leading dot) is what makes it match a subdomain only, so
 * `evilmyhuaweicloud.com` does not pass. The corporate/HCS domains are not
 * listed because no endpoint this plugin knows serves from them.
 */
const ALLOWED_DOMAINS = [
  // Every public-cloud endpoint this plugin calls is a subdomain of this one:
  // `ecs.<region>`, `obs.<region>`, `<bucket>.obs.<region>`, `bss`, `rms`,
  // `iam.<region>`, `apiexplorer.<region>`.
  '.myhuaweicloud.com',
] as const

/**
 * Whether a URL may be signed for.
 *
 * The scheme is checked as strictly as the host. An `http://` URL would put the
 * access key on the wire in cleartext, and HMAC signing offers no protection
 * when the signature itself travels unprotected alongside the key id it was
 * derived from.
 *
 * @param url - the request URL.
 * @returns a message naming the refusal, or `undefined` to proceed.
 */
export function denyUnsignedTarget(url: URL): string | undefined {
  if (url.protocol !== 'https:') {
    return (
      `Refused: ${url.protocol}//${url.host} is not https, so the request would put the `
      + 'access key on the wire in cleartext. HuaweiCloud API endpoints are all https.'
    )
  }
  const host = url.hostname.toLowerCase()
  const allowed = ALLOWED_DOMAINS.some(domain => host.endsWith(domain) && host.length > domain.length)
  if (!allowed) {
    return (
      `Refused: ${url.host} is not a HuaweiCloud endpoint. This client signs requests with `
      + `the account's access key, so it will only send them to ${ALLOWED_DOMAINS.join(', ')}. `
      + 'Check the URL; if the endpoint is on another HuaweiCloud domain, that domain has to '
      + 'be added to this allowlist.'
    )
  }
  return undefined
}

/**
 * How much of a response body is kept.
 *
 * The 30-second timeout bounds how long an API may take, not how much it may
 * return: a listing endpoint answers a very large document quickly, and
 * `openapi_request` hands its result straight to the model. Unbounded, one
 * `GET` of an account's whole inventory could fill the conversation with data
 * nobody asked to read.
 *
 * 4 MB is well above every response this plugin's own tools consume — a
 * catalogue page is a few hundred KB — and well below what would crowd out a
 * conversation. When a body is cut, `truncated` says so, so the caller reports
 * a partial answer rather than presenting one as complete.
 */
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024

export interface SignedHttpResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
  /** True when the body was cut at {@link MAX_RESPONSE_BYTES}. */
  truncated?: boolean;
}

/**
 * Send a signed HTTP request to a HuaweiCloud API endpoint.
 *
 * The request is signed with SDK-HMAC-SHA256 (signer.ts). Host header is set
 * automatically; caller-provided headers are merged on top.
 *
 * @param creds optional explicit credentials. Omit to read the plugin store
 *        (the normal path).
 * @throws if not authenticated (call auth first) — only when `creds` is
 *         omitted and no credentials are stored.
 * @throws if read-only mode is in effect and the request is not a permitted
 *         read. The gate is unconditional — see permission/gate.ts.
 */
export async function signedHttp(
  method: string,
  url: URL,
  body: string,
  extraHeaders: Record<string, string> = {},
  creds?: Credentials,
): Promise<SignedHttpResponse> {
  // Gate before anything else — before credentials load, before signing. A
  // refused request must not be signed with the user's key, and must not
  // consume a credential lookup.
  //
  // The gate is unconditional — it does not depend on whether `creds` was
  // passed explicitly. An exemption keyed on a parameter's shape would open a
  // back door for any future caller of any method, while saying nothing about
  // what the request actually does.
  const refusal = denyHttp(method, url);
  if (refusal !== undefined) throw new PermissionRefusalError(refusal);

  // Then the destination, for the same reason and in the same place: the AK
  // rides on every signed request, so where it can go is decided once here
  // rather than by each caller.
  const untrusted = denyUnsignedTarget(url);
  if (untrusted !== undefined) throw new PermissionRefusalError(untrusted);

  const resolved = creds ?? await loadCredentials();
  // OBS uses a separate signature scheme (V2/OBS: HMAC-SHA1+base64). Dispatch
  // by host so openapi_request transparently works on OBS endpoints without
  // callers knowing which signer to use.
  const isObs = isObsHost(url.host);
  const headers: Record<string, string> = {
    Host: url.host,
    // OBS requests may carry non-JSON bodies (XML, octet-stream); default to
    // application/json only for IAM-style requests. OBS callers can override
    // via extraHeaders.
    ...(isObs ? {} : { "Content-Type": "application/json" }),
    ...extraHeaders,
  };
  if (isObs) {
    signObsRequest({
      method,
      url,
      headers,
      body,
      ak: resolved.ak,
      sk: resolved.sk,
      securityToken: resolved.securityToken,
    });
  } else {
    signRequest({
      method,
      url,
      headers,
      body,
      ak: resolved.ak,
      sk: resolved.sk,
      securityToken: resolved.securityToken,
    });
  }

  const init: RequestInit = { method, headers };
  if (body) init.body = body;
  // 30s timeout — API calls should not hang. AbortSignal.timeout is available
  // in Node 20+ (our engines requirement).
  init.signal = AbortSignal.timeout(30000);
  const r = await fetch(url, init);
  const respHeaders: Record<string, string> = {};
  r.headers.forEach((v, k) => { respHeaders[k] = v; });

  const { body: received, truncated } = await readCapped(r);
  return {
    status: r.status,
    headers: respHeaders,
    body: received,
    ...(truncated ? { truncated: true } : {}),
  };
}

/**
 * Read a response body, stopping at {@link MAX_RESPONSE_BYTES}.
 *
 * Streamed rather than `response.text()`, so the cap stops the read instead of
 * being applied to a string that has already cost the memory it was meant to
 * save. Exported because it IS the policy and should be testable on its own —
 * a test that re-implemented this loop would verify a copy.
 *
 * @param response - the response to drain.
 * @returns the body kept, and whether it was cut.
 */
export async function readCapped(
  response: { body: ReadableStream<Uint8Array> | null },
): Promise<{ readonly body: string, readonly truncated: boolean }> {
  const decoder = new TextDecoder();
  let received = '';
  let truncated = false;
  if (response.body !== null) {
    for await (const chunk of response.body) {
      const text = decoder.decode(chunk, { stream: true });
      if (received.length + text.length >= MAX_RESPONSE_BYTES) {
        received += text.slice(0, MAX_RESPONSE_BYTES - received.length);
        truncated = true;
        // Draining the rest would defeat the point of stopping.
        await response.body.cancel().catch(() => {});
        break;
      }
      received += text;
    }
    if (!truncated) received += decoder.decode();
  }
  return { body: received, truncated };
}
