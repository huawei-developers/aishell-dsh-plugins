/**
 * The loopback listener: the callback door, and the probe that proves it opens.
 *
 * ## What it is for
 *
 * In the out-of-band flow the cloud itself posts the credential, from the
 * browser, to `127.0.0.1:<port>` — the host is never in that path. So the host
 * must be listening on that port, on the machine the browser runs on, before
 * the browser goes anywhere. This module owns that listener end to end.
 *
 * ## Why binding and serving are separate steps
 *
 * The port has to be known before the login service can be asked to project a
 * redirect URI — one provider takes only the port out of it, and rejects a URI
 * with none. But the plan that says which path and origins to honour only
 * arrives from that same call. So the socket binds first and starts honouring
 * a plan second.
 *
 * Nothing can reach the listener in between: the URL containing the port has
 * been disclosed to nobody yet. A request that arrives anyway is answered
 * `503`, which is honest — the door exists and is not yet open for business.
 *
 * ## Why the probe lives here
 *
 * The listener already has to exist for the callback. The probe reuses it
 * rather than adding a second port, and — more to the point — it exercises
 * *the same machinery* the callback will: a cross-origin request from a page
 * to a loopback address, which means the same preflight, the same PNA
 * handling, and the same response headers. A probe on a throwaway port would
 * prove nothing about whether the real one works.
 *
 * The alternative was inferring reachability — from the socket address of the
 * `/api` request, or from `location.hostname` in the page. Both are wrong in
 * both directions. An SSH-forwarded session makes a distant browser look like
 * loopback to the host, and makes a distant host look like `localhost` to the
 * page; a LAN-addressed browser on the same machine looks remote to both.
 * Only an actual request answers the actual question, so this asks one.
 *
 * ## What makes it hard (every item here is a silent failure)
 *
 *   - **Listen on the plan's path, not a guess.** The callback goes to the
 *     path the plan names, which for one provider is `/` — a listener mounted
 *     anywhere else never receives it.
 *   - **Echo one origin, never the list, and never `*`.** An
 *     `Access-Control-Allow-Origin` header takes a single value. Writing `*`
 *     would let any page on the internet post a forged credential here.
 *   - **Send `Vary: Origin`.** Without it a cache can serve one origin's
 *     answer to another.
 *   - **Answer the Private Network Access preflight, when the plan says so.**
 *     A public page reaching loopback triggers a preflight carrying
 *     `Access-Control-Request-Private-Network`, and a response lacking the
 *     matching allow header makes the browser drop the real request. This
 *     never reproduces in local development — only in a real browser, where it
 *     looks like a login page that spins forever. The plan carries
 *     `requires_private_network_access`; the listener also requires the
 *     browser to have actually asked, so it never grants more than was
 *     requested.
 *   - **Cap the body.** The port is in a URL, so it is not a secret: any local
 *     process can post to it. A bound keeps that from becoming memory growth.
 *   - **Close after one payload.** It narrows the replay window, and a second
 *     post must not overwrite a credential that already arrived.
 *
 * ## The one thing this does not fix
 *
 * A local process can post here with any `Origin` it likes — CORS is a browser
 * policy and does not constrain a process. The service's own documentation
 * records this as unfixable at the receiving end. The defense is that the
 * credential is verified against the cloud before it is stored (see
 * `./login.ts`), which is why nothing here is treated as proof of anything.
 * This listener decides *whether a payload arrived*, never whether it is
 * trustworthy — and the probe is a diagnostic, an authorization check it is
 * not.
 *
 * @module @huaweidevtools/aishell-dsh-client-credentials/out-of-band/listener
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { CallbackPlan } from './contract.ts'
import { PROBE_HEADER } from '../login-status.ts'

/** Largest callback body accepted. A credential is a few fields; 64 KiB is generous. */
export const MAX_CALLBACK_BYTES = 64 * 1024

/** Header a browser sends on the preflight that precedes a loopback request. */
const PNA_REQUEST_HEADER = 'access-control-request-private-network'

/** Query parameter carrying the probe nonce. */
const PROBE_NONCE_PARAM = 'n'

/**
 * A bound socket that has not been told what to honour yet.
 *
 * Exists only between the bind and the plan arriving; see the module note.
 */
export interface BoundListener {
  /** Host address bound, always loopback. */
  readonly host: string
  /** Port the OS assigned — never assume a value. */
  readonly port: number
  /** `host:port`, for the `redirect_uri` and for comparison against the plan. */
  readonly address: string
  /**
   * Begin honouring a callback plan and a probe.
   *
   * @param plan - the provider's callback requirements.
   * @param probe - how to answer a reachability probe, or `undefined` for none.
   * @returns the serving listener.
   */
  readonly serve: (plan: CallbackPlan, probe?: ProbeConfig) => CallbackListener
  /** Stop listening without ever having served. */
  readonly close: () => void
}

/**
 * Borrow a loopback port, answer one probe, and give it back.
 *
 * ## What this is for
 *
 * The cloud posts a credential to `127.0.0.1` **as the browser's machine
 * resolves it**, so a browser login works only when that browser can reach a
 * listener on this host. Neither side can tell by looking — an SSH-forwarded
 * session makes a distant browser look local to the host and a distant host
 * look local to the page — so the page fetches a URL and the fetch is the
 * answer. A fetch that resolves means the page reached a socket here.
 *
 * ## How it ends
 *
 * Two ways, whichever comes first:
 *
 *   - **Someone reaches it.** The response is written, and the socket closes
 *     immediately after — the question has been answered, so the port has no
 *     further use.
 *   - **{@link PROBE_WINDOW_MS} passes.** Nobody came, which is itself an
 *     answer (this browser cannot reach loopback), and the socket closes.
 *
 * Either way the port is held for seconds at most. A probe borrowed to ask one
 * question must not outlive the asking — a card left open would otherwise keep
 * a socket for the life of the page, which is what the earlier design did.
 *
 * ## Why the nonce
 *
 * The probe answers whatever origin asks, because the page's own origin is by
 * definition not one of the cloud's. That is only safe with a secret: without
 * one, any page that swept local ports would get an answer, making this a
 * fingerprinting beacon for the plugin's presence. A caller without the nonce
 * is answered exactly as an empty port would be.
 *
 * ## What the caller gets, and what it does not
 *
 * A URL and nothing else. The caller cannot observe the port closing — it
 * closes on its own, either on being reached or when the window runs out — and
 * a promise for that would be a handle no caller has a use for. Awaiting it
 * would also mean a route waiting up to the whole window before answering,
 * which is precisely what the page cannot afford.
 *
 * @param path - the path the probe is served on.
 * @returns the URL to hand the page.
 */
export async function probeLoopback(path: string): Promise<{ readonly probeUrl: string }> {
  const bound = await bindLoopback()
  const nonce = randomProbeNonce()
  const reachable = Promise.withResolvers<boolean>()

  bound.serve(
    // A plan that matches nothing: this listener exists only for the probe, so
    // a callback arriving here is a stray and is refused by the path check.
    { address: bound.address, path: '\u0000', method: 'POST', correlation: 'none' },
    {
      path,
      nonce,
      onAnswered: () => {
        reachable.resolve(true)
        bound.close()
      },
    },
  )

  // The window is the fallback for a page that never fetches — a browser with
  // no route to loopback fails at the fetch, but a page that was closed before
  // it tried leaves nobody to do so.
  const timer = setTimeout(() => {
    reachable.resolve(false)
    bound.close()
  }, PROBE_WINDOW_MS)
  unrefIfPossible(timer)
  void reachable.promise.then(() => { clearTimeout(timer) })

  return { probeUrl: `http://${bound.address}${path}?n=${nonce}` }
}

/**
 * Detach a timer from the event loop, when the runtime has that notion.
 *
 * Node's timer objects carry `unref`; a browser's are numbers. This package's
 * tsconfig compiles against the DOM signature (the browser half is most of
 * it), so the method is reached through a narrow cast rather than declared.
 *
 * Exported because the login's deadline needs the same treatment, and two
 * copies of a three-line cast is how they drift.
 *
 * @param timer - the timer handle, of whichever shape this runtime uses.
 */
export function unrefIfPossible(timer: ReturnType<typeof setTimeout> | undefined): void {
  const candidate = timer as { unref?: () => void } | undefined
  if (typeof candidate?.unref === 'function') candidate.unref()
}

/**
 * How long a probe port is held.
 *
 * Generous for a request that takes under a millisecond when it works, because
 * the cost of the wait is a bound port and the cost of being too quick is
 * calling a working route unsupported. A page that is slow to get going —
 * a large bundle still parsing — still gets its answer.
 */
export const PROBE_WINDOW_MS = 30_000

/** A value that cannot be guessed from the port alone. */
function randomProbeNonce(): string {
  const bytes = new Uint8Array(16)
  globalThis.crypto.getRandomValues(bytes)
  return Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('')
}

/** How the probe asks for a pass. */
export interface ProbeConfig {
  /**
   * Path the probe is answered on.
   *
   * Distinct from the callback path on purpose: the probe carries no
   * credential, and a probe landing on the callback path would either be
   * treated as one or block the real one.
   */
  readonly path: string
  /**
   * Secret the probe must present.
   *
   * The probe is answered from whatever origin asks, because the page's own
   * origin is by definition not one of the cloud's callback origins. Echoing
   * an arbitrary origin is only safe because of this value: without it the
   * listener would answer any page that guessed the port, turning it into a
   * local-service fingerprinting beacon. With it, only a caller already
   * holding the nonce — which only the host and its own page ever see — gets
   * an answer.
   */
  readonly nonce: string
  /**
   * Called when the probe has been answered, so the socket can be given back.
   *
   * Fired after the response is written, which is what makes the answer true:
   * the page's fetch resolved, so it reached a socket here.
   */
  readonly onAnswered?: () => void
}

/** A listener honouring a plan, and the one credential it will accept. */
export interface CallbackListener {
  /** The address it bound to. */
  readonly address: string
  /**
   * Resolves with the decoded payload of the first accepted post.
   *
   * Rejects if the listener is closed or errors before a payload arrives.
   * Settles at most once.
   */
  readonly accepted: Promise<Record<string, unknown>>
  /**
   * Stop listening and drop any pending wait.
   *
   * Idempotent, and safe from a cleanup path that may run after the listener
   * already closed itself on receipt.
   */
  readonly close: () => void
}

/**
 * Whether an `Origin` matches an allowed origin exactly.
 *
 * Exact comparison, deliberately: a suffix or prefix rule would admit
 * `https://<allowed>.evil.com` and `https://evil-<allowed>`, and a
 * case-insensitive rule would admit a spelling the browser never sends. The
 * service's reference client makes the same choice for the same reason.
 *
 * @param allowed - the plan's list.
 * @param origin - the request's `Origin`, if any.
 * @returns the matched origin to echo, or `undefined` when nothing matched.
 */
function matchOrigin(allowed: readonly string[], origin: string | undefined): string | undefined {
  if (origin === undefined) return undefined
  return allowed.find(candidate => candidate === origin)
}

/**
 * Read a request's single header value.
 *
 * Node delivers a repeated header as an array; a preflight never legitimately
 * repeats these, so an array is treated as absent rather than joined into
 * something that would not match.
 *
 * @param request - the incoming request.
 * @param name - lowercase header name.
 */
function header(request: IncomingMessage, name: string): string | undefined {
  const value = request.headers[name]
  return typeof value === 'string' ? value : undefined
}

/** The path portion of a request target, without its query. */
function pathOf(request: IncomingMessage): string {
  return (request.url ?? '').split('?')[0] ?? ''
}

/** The value of one query parameter in a request target. */
function queryParam(request: IncomingMessage, name: string): string | undefined {
  const query = (request.url ?? '').split('?')[1]
  if (query === undefined) return undefined
  for (const pair of query.split('&')) {
    const [key, value] = pair.split('=')
    if (key === name) return value === undefined ? undefined : decodeURIComponent(value)
  }
  return undefined
}

/**
 * Write a CORS preflight answer.
 *
 * @param response - the response to write.
 * @param origin - the matched origin to echo.
 * @param allowMethods - methods to advertise.
 * @param allowHeaders - request headers to advertise, when any.
 * @param allowPrivateNetwork - whether the plan says the cloud's post is a
 *   private-network request. Both this and the browser's own request header
 *   must hold before the allow header is written.
 * @param request - the preflight, for its PNA request header.
 */
function writePreflight(
  response: ServerResponse,
  origin: string,
  allowMethods: string,
  allowHeaders: string | undefined,
  allowPrivateNetwork: boolean,
  request: IncomingMessage,
): void {
  const headers: Record<string, string | number> = {
    'access-control-allow-origin': origin,
    // Required whenever the allowed origin varies by request — which it does,
    // since the header echoes whichever one matched.
    vary: 'Origin',
    'access-control-allow-methods': allowMethods,
  }
  if (allowHeaders !== undefined) headers['access-control-allow-headers'] = allowHeaders
  // Two conditions, both necessary. The plan says the provider's callback
  // arrives this way; the browser says this particular request wants it. A
  // client that did not ask must not be told it is granted — the same
  // don't-widen-unasked principle as the origin echo.
  if (allowPrivateNetwork && header(request, PNA_REQUEST_HEADER) === 'true') {
    headers['access-control-allow-private-network'] = 'true'
  }
  response.writeHead(204, headers)
  response.end()
}

/**
 * Read a request body up to {@link MAX_CALLBACK_BYTES}.
 *
 * @param request - the request to drain.
 * @returns the decoded JSON object.
 * @throws when the body exceeds the bound, is not JSON, or is not an object.
 */
function readPayload(request: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const chunks: string[] = []
    let size = 0
    let settled = false
    const fail = (error: Error): void => {
      if (settled) return
      settled = true
      reject(error)
    }
    request.on('error', fail)
    request.on('data', (chunk) => {
      if (settled) return
      size += chunk.length
      if (size > MAX_CALLBACK_BYTES) {
        // Stop accumulating and stop reading. Pausing rather than destroying:
        // destroying the socket here would cut the `400` off before it
        // flushed, so the sender would see a hang-up instead of the reason.
        // Pausing bounds memory just as well — no further `data` is delivered
        // — while leaving the response deliverable.
        fail(new Error('Callback body exceeded the accepted size.'))
        request.pause()
        return
      }
      chunks.push(chunk.toString('utf8'))
    })
    request.on('end', () => {
      if (settled) return
      settled = true
      try {
        const parsed: unknown = JSON.parse(chunks.join(''))
        if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
          reject(new Error('Callback body is not a JSON object.'))
          return
        }
        resolve(parsed as Record<string, unknown>)
      } catch {
        reject(new Error('Callback body is not valid JSON.'))
      }
    })
  })
}

/**
 * Bind a loopback port, without yet honouring any plan.
 *
 * Binds before anything else happens, deliberately: the port appears in the
 * redirect URI and is therefore not a secret, so a local process could take it
 * first. Binding early and handing the actual port back is what makes the
 * ordering correct by construction rather than by care.
 *
 * @returns the bound socket.
 * @throws when the port cannot be bound.
 */
export async function bindLoopback(): Promise<BoundListener> {
  let handler: ((request: IncomingMessage, response: ServerResponse) => void) | undefined
  const server: Server = createServer((request, response) => {
    if (handler === undefined) {
      // Not serving yet: the plan has not arrived, so nothing can be matched
      // and no credential could be accepted. The port is not yet public, so
      // this is a stray request rather than a race worth engineering around.
      response.writeHead(503)
      response.end()
      return
    }
    handler(request, response)
  })

  await new Promise<void>((resolve, reject) => {
    server.on('listening', () => { resolve() })
    server.on('error', (error: Error) => { reject(error) })
    // Port 0: the OS picks a free one. The address is loopback because the
    // cloud posts to the machine the browser runs on, which is this feature's
    // whole premise.
    server.listen(0, '127.0.0.1')
  })

  const address = server.address()
  if (address === null || typeof address === 'string') {
    server.close()
    throw new Error('The callback listener bound without an address.')
  }
  const bound = `127.0.0.1:${String(address.port)}`
  let closed = false

  return {
    host: '127.0.0.1',
    port: address.port,
    address: bound,
    close: () => {
      if (closed) return
      closed = true
      server.close()
    },
    serve: (plan, probe) => {
      const allowed = plan.allow_origins ?? []
      // Whether a cross-origin preflight should be told private-network access
      // is granted. The plan states it; an older service omits it, which reads
      // as false — correct for any provider whose callback is not a
      // public-page-to-loopback request.
      const allowPrivateNetwork = plan.requires_private_network_access === true
      let settleAccepted: (payload: Record<string, unknown>) => void
      let failAccepted: (error: Error) => void
      const accepted = new Promise<Record<string, unknown>>((resolve, reject) => {
        settleAccepted = resolve
        failAccepted = reject
      })
      // A rejection with no awaiter would be an unhandled rejection if the
      // caller closed the listener before waiting. A no-op handler keeps that
      // quiet; the real consumer attaches its own to the same promise.
      accepted.catch(() => {})

      let received = false
      server.on('error', (error: Error) => { failAccepted(error) })

      const close = (): void => {
        if (closed) return
        closed = true
        server.close()
      }

      /** Whether this request is the probe: right path, and the nonce it was given. */
      const isProbe = (request: IncomingMessage): boolean =>
        probe !== undefined
        && pathOf(request) === probe.path
        && queryParam(request, PROBE_NONCE_PARAM) === probe.nonce

      handler = (request, response) => {
        const method = request.method ?? ''

        if (probe !== undefined && pathOf(request) === probe.path) {
          if (method === 'OPTIONS') {
            const origin = header(request, 'origin')
            // A preflight with no Origin is not a preflight; answer it as the
            // not-found it effectively is.
            if (origin === undefined || !isProbe(request)) {
              response.writeHead(204)
              response.end()
              return
            }
            // The probe header is advertised because the probe sends it — that
            // is what forces the preflight this handler is answering. See
            // `../client/login-flow.ts`.
            writePreflight(response, origin, 'GET, OPTIONS', PROBE_HEADER, allowPrivateNetwork, request)
            // A preflight is a request that arrived, so it answers the question
            // as well as the fetch would: the browser reached this socket. It
            // ends the probe here so a page whose real request is then blocked
            // does not hold the port for the rest of the window.
            probe.onAnswered?.()
            return
          }
          // A caller that cannot present the nonce is answered exactly as an
          // empty port would answer, so a page scanning for local services
          // learns nothing from this one.
          if (method !== 'GET' || !isProbe(request)) {
            response.writeHead(404)
            response.end()
            return
          }
          const origin = header(request, 'origin')
          // A same-origin or non-browser probe (no Origin) still proves
          // reachability and has nothing to leak; only a cross-origin caller
          // needs the echo in order to read the answer at all.
          response.writeHead(204, origin === undefined
            ? {}
            : { 'access-control-allow-origin': origin, vary: 'Origin' })
          response.end()
          // Answered, so the port has done its job. The callback below is what
          // closes it; see `probeLoopback`.
          probe.onAnswered?.()
          return
        }

        if (method === 'OPTIONS') {
          const origin = matchOrigin(allowed, header(request, 'origin'))
          // An unmatched origin gets a bare 204: the browser will refuse the
          // real request anyway, and answering with headers would suggest it
          // might not.
          if (origin === undefined) {
            response.writeHead(204)
            response.end()
            return
          }
          writePreflight(
            response,
            origin,
            `${plan.method}, OPTIONS`,
            plan.content_type === undefined || plan.content_type === '' ? undefined : 'Content-Type',
            allowPrivateNetwork,
            request,
          )
          return
        }

        if (method !== plan.method) {
          response.writeHead(405)
          response.end()
          return
        }
        if (pathOf(request) !== plan.path) {
          response.writeHead(404)
          response.end()
          return
        }
        // A second post must not overwrite the first: the first is the one
        // being verified, and a local process can post here at any time.
        if (received) {
          response.writeHead(409)
          response.end()
          return
        }

        const origin = matchOrigin(allowed, header(request, 'origin'))
        // When the plan names origins, one must match. An absent Origin is
        // refused: over plain HTTP a browser omits it on reads, so an unmarked
        // post is either a non-browser client or a rebound page, and neither
        // is the callback this listener waits for.
        if (allowed.length > 0 && origin === undefined) {
          response.writeHead(403)
          response.end()
          return
        }

        void readPayload(request).then(
          (payload) => {
            if (closed || received) {
              response.writeHead(409)
              response.end()
              return
            }
            received = true
            const headers: Record<string, string | number> = {}
            if (origin !== undefined) {
              headers['access-control-allow-origin'] = origin
              headers.vary = 'Origin'
            }
            response.writeHead(200, headers)
            response.end()
            settleAccepted(payload)
            // The listener has done its job. Leaving it open would only widen
            // the window for a second post.
            close()
          },
          (error: unknown) => {
            if (closed) return
            response.writeHead(400)
            response.end()
            failAccepted(error instanceof Error ? error : new Error(String(error)))
            // The listener stays open after a malformed body: a local process
            // can always send one, and closing on it would let that process
            // deny the real callback by posting garbage first.
          },
        )
      }

      return { address: bound, accepted, close }
    },
  }
}
