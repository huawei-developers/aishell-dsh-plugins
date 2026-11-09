/**
 * The host-side routes the browser half drives a browser login through.
 *
 * ## Why the flow lives on the host
 *
 * None of it can live in the browser half: the credential arrives at a
 * loopback socket only the host can bind, the plan comes from a service the
 * host reaches, and verification needs the signer. So the host owns the flow
 * and the browser half asks for each step.
 *
 * ## The three routes, and why there is no fourth
 *
 *   POST .../login/probe   -> borrow a port, answer with where to fetch it
 *   POST .../login/start   -> bind, fetch the plan, start serving; answer with
 *                             where to send the browser
 *   POST .../login/cancel  -> the person dismissed the form
 *
 * The probe is separate from the start because they answer different questions
 * at different times: *can this browser reach this host at all* (asked when the
 * card opens, and holding a port for seconds) versus *begin a login* (asked on
 * a click, and holding a port for as long as the person takes).
 *
 * There is deliberately no `finish`. The outcome arrives on its own schedule —
 * whenever the person finishes signing in, up to ten minutes later — so
 * polling for it would mean a long-held HTTP request, which proxies time out
 * and which this codebase already has a better channel for: the entry's
 * settings document, which the browser half subscribes to. See
 * `./login-status.ts`. The host stores the credential and records the outcome
 * there; nothing needs to ask.
 *
 * ## What `start` does and does not guarantee
 *
 * It returns once a listener is bound and a plan is honoured. It says nothing
 * about whether the browser can *reach* that listener — only a request from
 * the browser answers that, which is what the probe route is for. The page
 * fetches the URL the probe hands it and decides; the host is not told the
 * result, because the page's decision is the only thing that uses it.
 *
 * @module @huaweidevtools/aishell-dsh-client-credentials/out-of-band/routes
 */

import type { ProviderInfo } from './contract.ts'

/** Path the browser half posts to, to ask whether the browser route works here. */
export const LOGIN_PROBE_ROUTE = '/api/aishell/credentials/login/probe'
/** Path the browser half posts to, to begin a login. */
export const LOGIN_START_PATH = '/api/aishell/credentials/login/start'
/** Path the browser half posts to, to abandon a login. */
export const LOGIN_CANCEL_PATH = '/api/aishell/credentials/login/cancel'

/**
 * Path the probe is served on.
 *
 * On the borrowed listener rather than the host's `/api` route: the question is
 * whether the browser can reach *that* socket, so the probe has to be answered
 * there. Under a name no provider will use as a callback path — the shipped
 * provider posts to the root, so anything else is free.
 */
export const LOGIN_PROBE_PATH = '/__aishell_probe'

/**
 * What the browser half is told when a login starts.
 *
 * No probe URL here. Whether a browser can reach a loopback listener depends
 * on how the page is reached, not on any login, and is asked once when the card
 * opens. See {@link ProbeAnswer}.
 */
export interface LoginStartResult {
  readonly ok: true
  /** URL to open in the browser, projected for the port this login bound. */
  readonly loginUrl: string
  /** Provider being signed in with, for the copy the form shows. */
  readonly providerName: string
  /**
   * Seconds until the login stops being completable.
   *
   * The card counts down to this so the person can see how long they have,
   * instead of watching a wait that will eventually just stop.
   */
  readonly expiresInSeconds: number
}

/**
 * What the browser half is told when it asks whether the route works.
 *
 * Only a URL. The browser fetches it and learns the answer itself: a fetch that
 * resolves means a page on this machine reached a loopback listener, and one
 * that rejects means it did not. Routing that answer back through the host
 * would be a second round trip to learn something the caller already knows.
 *
 * The listener behind the URL closes as soon as it has been reached, or after
 * {@link PROBE_WINDOW_MS} if it never is — a port borrowed to ask one question
 * must not outlive the asking.
 */
export interface ProbeAnswer {
  readonly ok: true
  /** URL to fetch, on the listener bound for this probe. */
  readonly probeUrl: string
}

/** Host-side operations the routes delegate to, injected so they are testable. */
export interface LoginRouteDeps {
  /**
   * Look up a provider by id.
   *
   * @param providerId - the provider the browser half asked for.
   * @returns the provider, or `undefined` when the service does not offer it.
   */
  readonly findProvider: (providerId: string) => Promise<ProviderInfo | undefined>
  /**
   * Borrow a loopback port and hand back a URL to fetch.
   *
   * The caller's browser fetches it and learns the answer itself; the port is
   * released once it has been reached, or after a short window. Needs no
   * provider: whether a socket here is reachable is a fact about the
   * access route, not about any cloud.
   */
  readonly probe: () => Promise<{ probeUrl: string }>
  /**
   * Bind a listener and fetch a login URL projected for it.
   *
   * Resolves once the URL is known. The credential is not awaited here — it
   * arrives whenever the person finishes, and is delivered through the
   * settings document rather than as this call's result.
   *
   * @param provider - the provider to sign in with.
   */
  readonly begin: (provider: ProviderInfo) => Promise<LoginStartResult>
  /** Abandon any login in progress and release its port. */
  readonly cancel: () => void
  /** Whether a login is already in progress. */
  readonly inProgress: () => boolean
}

/** One JSON response the browser half reads. */
function json(body: unknown, status = 200): Response {
  return Response.json(body, { status, headers: { 'cache-control': 'no-store' } })
}

/** Read a JSON object body, or `{}` when it is absent or unreadable. */
async function readBody(request: Request): Promise<Record<string, unknown>> {
  try {
    const parsed: unknown = JSON.parse(await request.text())
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {}
  } catch {
    return {}
  }
}

/** The login routes, bound to their collaborators. */
export function createLoginRoutes(deps: LoginRouteDeps): {
  probe: () => Promise<Response>
  start: (request: Request) => Promise<Response>
  cancel: () => Promise<Response>
} {
  const { findProvider, probe, begin, cancel, inProgress } = deps

  return {
    probe: async (): Promise<Response> => {
      // No in-progress guard: this borrows its own port for a few seconds and
      // releases it, so it neither disturbs a login nor is disturbed by one.
      try {
        return json({ ok: true, ...await probe() } satisfies ProbeAnswer)
      } catch (error) {
        // No loopback socket at all — sandboxed, or every port taken. The page
        // reads this as "the route does not work here".
        return json({
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        }, 503)
      }
    },

    start: async (request: Request): Promise<Response> => {
      // One login at a time. The shipped provider's callback carries no
      // correlation string, so two concurrent logins could not be told apart
      // — and the service's own contract says a login occupies a port.
      if (inProgress()) {
        return json({ ok: false, error: 'A browser login is already in progress.' }, 409)
      }
      const body = await readBody(request)
      const providerId = typeof body.provider === 'string' && body.provider !== ''
        ? body.provider
        : 'huaweicloud'

      let provider: ProviderInfo | undefined
      try {
        provider = await findProvider(providerId)
      } catch (error) {
        // The login service is unreachable or answered unusably. The card
        // shows the browser route as unsupported for this, the same as when the
        // browser cannot reach loopback — the person's next move is the same
        // either way, but the cause is not the access route and saying so here
        // keeps the two apart for whoever reads this next.
        return json({
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        }, 503)
      }
      if (provider === undefined) {
        return json({ ok: false, error: `No login provider named ${providerId}.` }, 404)
      }
      if (provider.delivery !== 'out_of_band') {
        // Only the out-of-band flow is implemented. A brokered provider needs
        // an exchange step, and no provider offers that today.
        return json({
          ok: false,
          error: `Provider ${providerId} uses "${provider.delivery}", which this plugin cannot complete.`,
        }, 501)
      }

      try {
        return json(await begin(provider))
      } catch (error) {
        return json({
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        }, 502)
      }
    },

    cancel: (): Promise<Response> => {
      cancel()
      return Promise.resolve(json({ ok: true }))
    },
  }
}
