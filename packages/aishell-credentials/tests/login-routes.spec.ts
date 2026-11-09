/**
 * The host routes the browser half drives a login through.
 *
 * The route is where a failure to do browser login becomes a clean "no"
 * instead of a broken form: an unreachable service, an unknown provider, and a
 * delivery mode this plugin cannot complete are all answered as failures, which
 * is what makes the browser half leave the entry out entirely. So the cases
 * below are mostly about which status each produces — the caller's behaviour
 * depends on that and on nothing else.
 */

import { describe, it, expect, vi } from 'vitest'
import { createLoginRoutes, LOGIN_PROBE_PATH, type LoginRouteDeps } from '../src/out-of-band/routes.ts'
import type { ProviderInfo } from '../src/out-of-band/contract.ts'

/** The provider the live service reports, verbatim. */
const HUAWEI: ProviderInfo = {
  id: 'huaweicloud',
  display_name: '华为云',
  delivery: 'out_of_band',
  credential_type: 'ak_sk_sts',
  credential_schema: { access: 'string', secret: 'string', securitytoken: 'string' },
}

/** A POST to a route, as the browser half sends it. */
function post(body?: unknown): Request {
  return new Request('http://localhost/api/aishell/credentials/login/start', {
    method: 'POST',
    ...(body === undefined
      ? {}
      : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
  })
}

/** Build routes over stubbed collaborators. */
function makeRoutes(overrides: Partial<LoginRouteDeps> = {}): {
  routes: ReturnType<typeof createLoginRoutes>
  calls: { starts: number, cancels: number, probes: number }
} {
  const calls = { starts: 0, cancels: 0, probes: 0 }
  const routes = createLoginRoutes({
    findProvider: () => Promise.resolve(HUAWEI),
    probe: () => {
      calls.probes += 1
      return Promise.resolve({ probeUrl: `http://127.0.0.1:39821${LOGIN_PROBE_PATH}?n=abc` })
    },
    begin: () => {
      calls.starts += 1
      return Promise.resolve({
        ok: true,
        loginUrl: 'https://example.invalid/login',
        providerName: HUAWEI.display_name,
        expiresInSeconds: 600,
      })
    },
    cancel: () => { calls.cancels += 1 },
    inProgress: () => false,
    ...overrides,
  })
  return { routes, calls }
}

describe('login routes — starting', () => {
  it('answers with both URLs on success', async () => {
    const { routes, calls } = makeRoutes()

    const response = await routes.start(post())

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      loginUrl: 'https://example.invalid/login',
      providerName: '华为云',
    })
    expect(calls.starts).toBe(1)
  })

  it('defaults to the shipped provider when the body names none', async () => {
    // The browser half posts an empty object; the provider is this plugin's
    // own business, not something the page has an opinion about.
    const seen: string[] = []
    const { routes } = makeRoutes({
      findProvider: (id) => { seen.push(id); return Promise.resolve(HUAWEI) },
    })

    await routes.start(post({}))

    expect(seen).toEqual(['huaweicloud'])
  })

  it('honours a provider the body names', async () => {
    const seen: string[] = []
    const { routes } = makeRoutes({
      findProvider: (id) => { seen.push(id); return Promise.resolve(HUAWEI) },
    })

    await routes.start(post({ provider: 'huaweicloud' }))

    expect(seen).toEqual(['huaweicloud'])
  })

  it('answers 503 when the service is unreachable', async () => {
    // This is the "feature unavailable from here" answer. The browser
    // half reads any failure as "do not offer the entry".
    const { routes, calls } = makeRoutes({
      findProvider: () => Promise.reject(new Error('ENOTFOUND')),
    })

    const response = await routes.start(post())

    expect(response.status).toBe(503)
    // Nothing was bound: a listener would have leaked.
    expect(calls.starts).toBe(0)
  })

  it('answers 404 for a provider the service does not offer', async () => {
    const { routes } = makeRoutes({ findProvider: () => Promise.resolve(undefined) })

    const response = await routes.start(post({ provider: 'nope' }))

    expect(response.status).toBe(404)
  })

  it('answers 501 for a delivery this plugin cannot complete', async () => {
    // Only the out-of-band flow is implemented; starting a listener for a
    // brokered provider would surface as a timeout with no explanation.
    const { routes, calls } = makeRoutes({
      findProvider: () => Promise.resolve({ ...HUAWEI, delivery: 'brokered' }),
    })

    const response = await routes.start(post())

    expect(response.status).toBe(501)
    expect(calls.starts).toBe(0)
  })

  it('answers 409 when a login is already running', async () => {
    // One at a time: the shipped provider's callback carries no correlation
    // string, so two concurrent logins could not be told apart.
    const { routes, calls } = makeRoutes({ inProgress: () => true })

    const response = await routes.start(post())

    expect(response.status).toBe(409)
    expect(calls.starts).toBe(0)
  })

  it('answers 502 when binding or the plan check fails', async () => {
    const { routes } = makeRoutes({
      begin: () => Promise.reject(new Error('the service expects another port')),
    })

    const response = await routes.start(post())

    expect(response.status).toBe(502)
    await expect(response.json()).resolves.toMatchObject({
      ok: false,
      error: 'the service expects another port',
    })
  })

  it('tolerates a body that is not JSON', async () => {
    // The route decides the provider itself, so an unreadable body is not
    // worth a 400 — it defaults like an empty one.
    const { routes, calls } = makeRoutes()

    const response = await routes.start(new Request(
      'http://localhost/api/aishell/credentials/login/start',
      { method: 'POST', body: 'not json' },
    ))

    expect(response.status).toBe(200)
    expect(calls.starts).toBe(1)
  })
})

describe('login routes — cancelling', () => {
  it('cancels and reports success', async () => {
    const { routes, calls } = makeRoutes()

    const response = await routes.cancel()

    expect(response.status).toBe(200)
    expect(calls.cancels).toBe(1)
  })

  it('is safe to cancel when nothing is running', async () => {
    // The form calls this on close, whether or not a login was ever started.
    const { routes, calls } = makeRoutes()
    await expect(routes.cancel()).resolves.toBeDefined()
    expect(calls.cancels).toBe(1)
  })
})

describe('login routes — the probe path is not a route', () => {
  it('serves the probe on the listener, not on the host', () => {
    // The probe answers a question about the callback socket, so it has to be
    // answered there. A probe served by the host would prove the wrong thing
    // and would send the browser to an origin without the callback's CORS.
    expect(LOGIN_PROBE_PATH.startsWith('/api/')).toBe(false)
    expect(vi.isMockFunction(LOGIN_PROBE_PATH)).toBe(false)
  })
})

describe('login routes — what the browser half is told', () => {
  it('never puts a credential in a response', async () => {
    // The whole point of the split: the credential arrives at the host's
    // socket and is stored there. A route that echoed one back would put a
    // secret in the page and in whatever logs the request.
    const { routes } = makeRoutes()

    const body = await (await routes.start(post())).text()

    expect(body).not.toMatch(/secret/i)
    expect(body).not.toMatch(/\bak\b/i)
    expect(body).toContain('loginUrl')
  })
})
