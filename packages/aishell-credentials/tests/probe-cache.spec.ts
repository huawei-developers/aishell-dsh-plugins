/**
 * The browser route probe: asked once per page, and abandoned with its card.
 *
 * Two properties, both about not repeating work that cannot have changed.
 *
 * **Once per page.** Whether a browser can reach a loopback socket on the host
 * is a fact about how this page is reached, not about any one card. Re-asking
 * per card meant a bound port, a loopback request and a CORS preflight every
 * time — for an answer that was already known. `__resetRouteProbe` exists for
 * tests, which need each case to start from "not asked".
 *
 * **Abandoned with its card.** The loopback request carries the card's abort
 * signal, so closing the card mid-probe stops the request rather than leaving
 * it to run out its timeout. The host's port is not released by this — it never
 * learns the page gave up — but its own window closes that.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

const { probeBrowserRoute, __resetRouteProbe } = await import('../src/client/login-flow.ts')

/** Requests the stub saw, in order. */
let calls: Array<{ url: string, aborted: boolean }> = []

/** Whether the loopback fetch should resolve, reject, or hang. */
let loopback: 'reachable' | 'refused' | 'hang' = 'reachable'

/**
 * A `fetch` stub: the probe route answers with a URL, the loopback fetch
 * behaves as `loopback` says.
 */
function stubFetch(): void {
  vi.stubGlobal('fetch', ((input: string | URL | Request, init?: RequestInit) => {
    const url = String(input)
    const record = { url, aborted: false }
    calls.push(record)
    init?.signal?.addEventListener('abort', () => { record.aborted = true })

    if (url.includes('/login/probe')) {
      return Promise.resolve(Response.json({ ok: true, probeUrl: 'http://127.0.0.1:39821/probe?n=x' }))
    }
    switch (loopback) {
      case 'reachable':
        return Promise.resolve(new Response(null, { status: 204 }))
      case 'refused':
        return Promise.reject(new Error('net::ERR_CONNECTION_REFUSED'))
      case 'hang':
        return new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => { reject(new Error('aborted')) })
        })
    }
  }) as unknown as typeof fetch)
}

beforeEach(() => {
  calls = []
  loopback = 'reachable'
  __resetRouteProbe()
  stubFetch()
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('the probe is asked once per page', () => {
  it('answers a second caller from the first answer', async () => {
    // The card remounts on every open, so without this a person who closed and
    // reopened the card would bind another port and send another request to
    // learn what had not changed.
    await expect(probeBrowserRoute()).resolves.toBe(true)
    await expect(probeBrowserRoute()).resolves.toBe(true)

    expect(calls).toHaveLength(2) // one probe POST, one loopback fetch
  })

  it('shares one in-flight probe between two callers', async () => {
    // Two cards opened together must not race two probes. Stored as the promise
    // rather than its value, so the second caller joins the first.
    loopback = 'hang'
    const first = probeBrowserRoute()
    const second = probeBrowserRoute()
    // The probe POST is itself async, and reaching the loopback fetch takes a
    // real turn of the event loop — a microtask flush is not enough.
    await new Promise(resolve => setTimeout(resolve, 5))

    // One probe POST and one loopback fetch — the second caller joined the
    // first rather than starting its own.
    expect(calls).toHaveLength(2)
    expect(calls.filter(call => call.url.includes('/login/probe'))).toHaveLength(1)
    void first
    void second
  })

  it('remembers a negative answer too', async () => {
    // The answer is a property of the route, and "no" is as much an answer
    // as "yes". Re-asking would bind a port per card to be told the same thing.
    loopback = 'refused'
    await expect(probeBrowserRoute()).resolves.toBe(false)
    await expect(probeBrowserRoute()).resolves.toBe(false)

    expect(calls).toHaveLength(2)
  })

  it('does not remember a failure to reach the host at all', async () => {
    // A route that is not answering may answer a moment later — the host half
    // could be mid-reload. Caching that would strand the card on "unsupported"
    // for the life of the page.
    let attempts = 0
    vi.stubGlobal('fetch', (() => {
      attempts += 1
      return Promise.reject(new Error('host unreachable'))
    }) as unknown as typeof fetch)

    await expect(probeBrowserRoute()).resolves.toBe(false)
    expect(attempts).toBe(1)

    // The second call asks again rather than reusing the failure: a host that
    // was mid-reload a moment ago may be answering now.
    await expect(probeBrowserRoute()).resolves.toBe(false)
    expect(attempts).toBe(2)
  })
})

describe('the probe is abandoned with its card', () => {
  it('stops the loopback request when the card goes away', async () => {
    loopback = 'hang'
    const controller = new AbortController()

    const pending = probeBrowserRoute(controller.signal)
    // Let the probe POST resolve so the loopback fetch is the one in flight.
    await new Promise(resolve => setTimeout(resolve, 5))
    expect(calls).toHaveLength(2)

    controller.abort()

    await expect(pending).resolves.toBe(false)
    // The request was told to stop, rather than left to run out its timeout.
    expect(calls[1]?.aborted).toBe(true)
  })

  it('does not remember an abort as an unsupported route', async () => {
    // Closing a card mid-probe is not a statement about the route. If it were
    // cached as "unsupported", every later card would hide the browser route
    // for the rest of the page's life.
    loopback = 'hang'
    const controller = new AbortController()

    const pending = probeBrowserRoute(controller.signal)
    await new Promise(resolve => setTimeout(resolve, 5))
    controller.abort()
    await expect(pending).resolves.toBe(false)

    // A later card asks again, and this time the route works.
    loopback = 'reachable'
    await expect(probeBrowserRoute()).resolves.toBe(true)
  })

  it('is unaffected by an abort when the answer already arrived', async () => {
    const controller = new AbortController()
    await expect(probeBrowserRoute(controller.signal)).resolves.toBe(true)

    // Aborting after the fact must not turn a known answer into a failure.
    controller.abort()
    await expect(probeBrowserRoute()).resolves.toBe(true)
  })
})
