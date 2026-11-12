/**
 * The share service, as this plugin calls it.
 *
 * Pure HTTP over `fetch`, no cordis types, so the request and response handling
 * can be tested against a stub. The two operations are the whole interface: a
 * link comes back from one, a package from the other.
 *
 * @module @huaweidevtools/aishell-dsh-share/service
 */

import { SESSION_KIND } from './route.ts'

/** What a created share is. */
export interface CreatedShare {
  /** The link to hand out, exactly as the service spelled it. */
  readonly url: string
}

/** How a service call ended. */
export type ServiceResult<T> =
  | { readonly ok: true, readonly value: T }
  | { readonly ok: false, readonly reason: ServiceFailure }

/**
 * Why a step failed, in terms a dialog can show.
 *
 * The first four come from the share service; `bad-request` is this plugin's
 * own verdict on a request that named nothing usable.
 */
export type ServiceFailure =
  /** The service refused the request's content. */
  | 'rejected'
  /** The link names nothing, or has expired. */
  | 'unavailable'
  /** The package is larger than the service accepts. */
  | 'too-large'
  /** The service is failing or unreachable. */
  | 'unavailable-service'
  /** The request itself was malformed — no id, or no workspace to file under. */
  | 'bad-request'

/**
 * Create one share.
 *
 * @param origin - the service's base URL.
 * @param body - the package, serialised as JSON.
 * @param signal - cancellation for the request.
 * @returns the link, or why it could not be made.
 */
export async function createShare(
  origin: string,
  body: string,
  signal?: AbortSignal,
): Promise<ServiceResult<CreatedShare>> {
  const response = await fetch(`${origin}/share/${SESSION_KIND}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'content-encoding': 'gzip',
    },
    body: await gzip(body),
    ...signal === undefined ? {} : { signal },
  }).catch(() => undefined)

  if (response === undefined) return { ok: false, reason: 'unavailable-service' }
  if (!response.ok) return { ok: false, reason: classify(response.status) }

  const payload = await response.json().catch(() => undefined) as { url?: unknown } | undefined
  if (typeof payload?.url !== 'string' || payload.url === '') return { ok: false, reason: 'rejected' }
  return { ok: true, value: { url: payload.url } }
}

/**
 * Read one share.
 *
 * @param origin - the service's base URL.
 * @param id - the id taken from the link.
 * @param signal - cancellation for the request.
 * @returns the response body's text, or why it could not be read.
 */
export async function readShare(
  origin: string,
  id: string,
  signal?: AbortSignal,
): Promise<ServiceResult<string>> {
  const response = await fetch(`${origin}/share/${SESSION_KIND}/${encodeURIComponent(id)}`, {
    method: 'GET',
    ...signal === undefined ? {} : { signal },
  }).catch(() => undefined)

  if (response === undefined) return { ok: false, reason: 'unavailable-service' }
  if (!response.ok) return { ok: false, reason: classify(response.status) }
  return { ok: true, value: await response.text() }
}

/**
 * Map one HTTP status to what the dialog should say.
 *
 * @param status - the response status.
 * @returns the failure the reader can act on.
 */
function classify(status: number): ServiceFailure {
  if (status === 404 || status === 410) return 'unavailable'
  if (status === 413) return 'too-large'
  if (status >= 500) return 'unavailable-service'
  return 'rejected'
}

/**
 * Compress a body for upload.
 *
 * A conversation of any length compresses to a small fraction of its size, and
 * the share endpoint expects the compressed form.
 *
 * @param body - the JSON text.
 * @returns the gzipped bytes, as a body `fetch` accepts.
 */
async function gzip(body: string): Promise<ArrayBuffer> {
  const stream = new Blob([body]).stream().pipeThrough(new CompressionStream('gzip'))
  return new Response(stream).arrayBuffer()
}