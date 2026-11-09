/**
 * Browser-login support, as the form sees it.
 *
 * ## What the form needs to know
 *
 * Two things, and they arrive by different routes:
 *
 *   - **Can the browser reach the host from where it is?** Answered by the
 *     probe, on demand, because only the browser can answer it. See below.
 *   - **How did the last attempt end?** Read from the entry's settings
 *     document, which the host writes when the credential lands — the person
 *     may be at the cloud for minutes, so there is nothing to await.
 *
 * ## Why the capability is probed rather than assumed
 *
 * A browser login works only when the browser can reach a listener on the
 * host. Neither side can tell by looking: an SSH-forwarded session makes a
 * distant browser look local to the host, and a distant host look local to the
 * page. So the browser asks a question only it can ask — *can I reach the
 * host's listener?* — by fetching it. See {@link probeBrowserRoute}.
 *
 * ## The cost of asking
 *
 * The probe borrows a loopback port on the host, is answered once, and gives
 * the port back. It does not begin a login: a card read and abandoned holds
 * nothing. Clicking the button is what binds a port for real, through
 * {@link startBrowserLogin}.
 *
 * @module @huaweidevtools/aishell-dsh-client-credentials/client/login-flow
 */

import { PROBE_HEADER } from '../login-status.ts'

/**
 * A browser login the host has begun and the browser can reach.
 *
 * Holding this means a listener is bound and waiting, so it must be released —
 * see {@link BrowserLoginHandle.cancel} — when the form closes without using
 * it.
 */
export interface BrowserLoginHandle {
  /** URL to open when the person chooses this path. */
  readonly loginUrl: string
  /** Provider's display name, for the copy that names it. */
  readonly providerName: string
  /**
   * Seconds until the login stops being completable, as the service stated it.
   *
   * The waiting card counts down to this. The host enforces the same number on
   * its listener, so what the person sees and what the port does agree.
   */
  readonly expiresInSeconds: number
  /** Release the host's listener; the login will not complete. */
  readonly cancel: () => void
}

/**
 * A signal that fires on the timeout, on the caller's abort, or not at all.
 *
 * `AbortSignal.timeout` alone would ignore the caller's signal, so a card
 * closed mid-probe would leave its request running for the rest of the
 * timeout. The two are combined rather than choosing one because both apply:
 * the request may be abandoned, and it may also hang.
 *
 * @param ms - the timeout.
 * @param caller - the caller's signal, if any.
 */
function withTimeout(ms: number, caller?: AbortSignal): AbortSignal {
  const timeout = AbortSignal.timeout(ms)
  if (caller === undefined) return timeout
  if (typeof AbortSignal.any !== 'function') return timeout
  return AbortSignal.any([timeout, caller])
}

/**
 * How long either call may take.
 *
 * Short, because both are expected to be immediate: a loopback request that
 * works answers in well under a millisecond. The bound exists so an access
 * route that cannot do this says so rather than leaving the card mid-check.
 */
const CALL_TIMEOUT_MS = 3000

/** Routes the browser half drives a login through. */
const LOGIN_PROBE_ROUTE = 'api/aishell/credentials/login/probe'
const LOGIN_START_ROUTE = 'api/aishell/credentials/login/start'
const LOGIN_CANCEL_ROUTE = 'api/aishell/credentials/login/cancel'

/** What the host answers the probe with. */
interface ProbeResponse {
  readonly ok: boolean
  readonly probeUrl?: string
  readonly error?: string
}

/** What the host answers a successful `start` with. */
interface StartResponse {
  readonly ok: boolean
  readonly loginUrl?: string
  readonly providerName?: string
  readonly expiresInSeconds?: number
  readonly error?: string
}

/** POST an empty body to a host route and read its JSON answer. */
async function post(route: string): Promise<Record<string, unknown> | undefined> {
  try {
    const response = await fetch(route, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
      signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
    })
    return await response.json() as Record<string, unknown>
  } catch {
    // The route is unreachable, which on this surface means the host half is
    // not serving it. Nothing to offer.
    return undefined
  }
}

/**
 * The probe's answer, for as long as this page lives.
 *
 * ## Why cached here
 *
 * The question is whether a browser on this machine can reach a socket on the
 * host, and it is a property of how this page is reached rather than of any
 * one card:
 * closing the card and opening it again does not move either machine. Asking
 * per card meant a bound port, a loopback request and a CORS preflight every
 * time — for an answer that had not changed.
 *
 * ## Why a promise, not the boolean
 *
 * Stored as the in-flight promise so two cards opened in quick succession share
 * one probe rather than racing two. The second caller joins the first's answer.
 *
 * ## Why it lives in the module and not the component
 *
 * The component remounts on every open — that is how a fresh card gets fresh
 * state — so anything held in its state is re-derived each time. A module-level
 * value survives that, which is the whole point.
 *
 * ## What invalidates it
 *
 * Nothing, for the life of the page. A person who sets up a tunnel to fix a
 * failed probe reloads, and a reload is the natural boundary: it is the same
 * act that re-establishes the page's connection to the host. A remembered
 * "no" that could never be revisited would be worse than the repeated probe;
 * a remembered "no" that lasts only until reload is not.
 *
 * ## The one thing not remembered
 *
 * A failure to reach the **host** at all. That is not an answer about the
 * route — the host may be mid-reload — and caching it would leave the card
 * saying "unsupported" for the rest of the page's life. So `runRouteProbe`
 * reports it as `undefined`, and only real answers are kept.
 */
let routeProbe: Promise<boolean | undefined> | undefined

/**
 * Ask whether a browser here can reach a loopback listener.
 *
 * ## What it tests, and why only this can
 *
 * The cloud posts a credential to `127.0.0.1` **as the browser's machine
 * resolves it**, so the flow works only when that browser can reach a listener
 * on this host. Neither side can tell by looking: an SSH-forwarded session
 * makes a distant browser look local to the host, and a distant host look local
 * to the page. So the host borrows a port, this page fetches it, and the fetch
 * *is* the answer — resolving means a socket here was reached, rejecting means
 * it was not.
 *
 * The port is released by the host as soon as it is reached, or after a short
 * window. Nothing is kept for the login that may follow: that binds its own
 * port, so a card read and abandoned holds nothing.
 *
 * ## Why the request carries a header
 *
 * The header makes it a non-simple request, so the browser sends a CORS
 * preflight first and only proceeds if the answer is right. The cloud's
 * callback is a JSON POST and therefore *always* preflights, so a plain GET
 * would test a path the callback never takes — and could pass on a route where
 * the real preflight fails, which is the one wrong answer this must not
 * give.
 *
 * @returns whether the route works here. Answered once per page, except when
 *   the host could not be reached — see {@link routeProbe}.
 */
export async function probeBrowserRoute(signal?: AbortSignal): Promise<boolean> {
  routeProbe ??= runRouteProbe(signal)
  const answer = await routeProbe
  // Only a real answer is kept. "The host half did not answer" is not one: it
  // can be a reload in progress, and remembering it would strand the card on
  // "unsupported" for the life of the page.
  if (answer === undefined) routeProbe = undefined
  return answer ?? false
}

/**
 * Drop the remembered probe answer.
 *
 * For tests, which need each case to probe for itself. Not called in
 * production: the answer is deliberately kept for the life of the page, and
 * discarding it would only make the next card ask again.
 */
export function __resetRouteProbe(): void {
  routeProbe = undefined
}

/**
 * One probe, from borrowing the port to reading the answer.
 *
 * @param signal - aborts the loopback request when the card that asked goes
 *   away. The host's port is not released by this — it never learns the page
 *   gave up — but the request stops, and the host's own window closes it. The
 *   result is still cached: the route did not change because a card closed.
 */
async function runRouteProbe(signal?: AbortSignal): Promise<boolean | undefined> {
  const answer = await post(LOGIN_PROBE_ROUTE) as ProbeResponse | undefined
  // `undefined` from `post` means the host half did not answer — see above for
  // why that is not remembered. An `ok: false` is the host saying the route is
  // unavailable here, which is an answer.
  if (answer === undefined) return undefined
  if (answer.ok !== true || typeof answer.probeUrl !== 'string' || answer.probeUrl === '') {
    return false
  }
  try {
    const reached = await fetch(answer.probeUrl, {
      method: 'GET',
      // The header is what forces the preflight; see the note above.
      headers: { [PROBE_HEADER]: '1' },
      signal: withTimeout(CALL_TIMEOUT_MS, signal),
    })
    return reached.ok
  } catch {
    // An abort means the card that asked went away — not an answer about the
    // route. Reporting it as `false` would cache "unsupported" for the
    // life of the page, so closing a card mid-probe would hide the browser
    // route from every later card.
    if (signal?.aborted === true) return undefined
    // Everything else is an answer, not an error: this is what an access
    // route that does not carry loopback looks like from the page — a tunnel that
    // proxies the page but not the loopback port, say. It is also what a
    // blocked request looks like (CSP, mixed content), which is the same
    // situation for the person — the callback cannot arrive either way.
    return false
  }
}

/**
 * Begin a login, now that the person has asked for one.
 *
 * Binds a port and fetches a URL projected for it at this moment, which is why
 * the URL is not stale however long the card sat open before the click.
 *
 * @returns a handle for the login in flight, or `undefined` when the host
 *   could not start one.
 */
export async function startBrowserLogin(): Promise<BrowserLoginHandle | undefined> {
  const started = await post(LOGIN_START_ROUTE) as StartResponse | undefined
  if (started?.ok !== true || typeof started.loginUrl !== 'string' || started.loginUrl === '') {
    return undefined
  }

  return {
    loginUrl: started.loginUrl,
    providerName: started.providerName ?? '',
    // A service that omits the figure leaves no countdown to show; the host
    // still enforces its own default, so the wait is bounded either way.
    expiresInSeconds: started.expiresInSeconds ?? 0,
    cancel: () => {
      void fetch(LOGIN_CANCEL_ROUTE, { method: 'POST' }).catch(() => {
        // The host releases the port when the plugin unloads or the next login
        // starts; a failed cancel is not worth surfacing to the person.
      })
    },
  }
}

/**
 * Open a blank tab now, and point it at the login page once there is one.
 *
 * ## Why the window is opened before the URL exists
 *
 * A popup is only allowed while the user gesture is live, and a gesture does
 * not survive an `await`. Fetching the login URL first — which is what this
 * has to do, because the URL names a port the host has not bound yet — would
 * spend the gesture, and a blocker would then refuse the tab. Opening the tab
 * synchronously and navigating it a moment later keeps the gesture intact.
 *
 * ## Why the opener reference is severed afterwards
 *
 * `window.open` returns `null` whenever `noopener` appears in its features
 * string — by specification, not as a failure — so passing it there would make
 * every successful open look blocked. The reference is cut immediately after
 * instead, which is the same protection without losing the success signal.
 *
 * @returns a handle whose `navigate` shows the login page, or `undefined` when
 *   the browser refused to open a tab at all.
 */
export interface LoginWindow {
  /** Point the tab at the login page. */
  readonly navigate: (url: string) => void
  /** Close the blank tab, when the login could not be started. */
  readonly close: () => void
}

/**
 * Open a blank tab, subject to the current user gesture.
 *
 * `undefined` means the browser gave back no window — a blocker, a popup
 * policy, an extension, or a runtime that does not implement `window.open` at
 * all. The card cannot tell these apart from the return value, which is why the
 * outcome is treated as ordinary rather than as a diagnosis: the running state's
 * 「点击此处打开」 is a real link, and a link the person chooses to follow is not
 * something a blocker refuses. A missing tab costs the automatic open and
 * nothing else.
 *
 * ## `about:blank`, and why it is spelled out
 *
 * The window is opened on `about:blank` rather than on an empty string. An
 * empty URL reads as "no document" in some implementations, where the window is
 * refused outright or left in a state the later navigation cannot use. The
 * shell's own sign-in popup opens `about:blank` for the same reason.
 *
 * @returns the handle, or `undefined` when no window was created.
 */
export function openLoginWindow(): LoginWindow | undefined {
  // `about:blank`, not an empty string. An empty URL means "no document" to
  // some implementations, and the window is refused or left unusable; the
  // shell's own sign-in popup opens `about:blank` for the same reason.
  const opened = window.open('about:blank', '_blank')
  if (opened === null) return undefined
  try {
    opened.opener = null
  } catch {
    // Cross-origin windows refuse the assignment; the reference is already
    // useless to us either way, so this is not a failure.
  }
  return {
    navigate: (url: string) => {
      try {
        // `replace`, not `href =`: the blank tab is a staging document, and a
        // history entry pointing at it serves nobody. The shell's sign-in popup
        // uses `replace` for the same reason.
        opened.location.replace(url)
      } catch {
        // A window that closed itself cannot be navigated; the running state's
        // 「点击此处打开」 link is the fallback.
      }
    },
    close: () => {
      try {
        opened.close()
      } catch {
        // Already closed, or cross-origin. Nothing to do either way.
      }
    },
  }
}
