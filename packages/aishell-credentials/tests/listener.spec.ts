/**
 * The loopback callback listener.
 *
 * Every property here is one whose failure mode is silent: a wrong listen
 * path, a missing `Vary`, a preflight answered without the PNA header, or a
 * body read without a bound all produce a login that simply never completes,
 * with nothing to see. So these cases drive a real socket rather than a fake —
 * the behavior under test *is* the HTTP exchange.
 *
 * The listener is also the one place where a wrong answer is a security
 * problem rather than a bug: it accepts a credential from a local port that
 * any process can reach. The origin and nonce cases below are what keep it
 * from becoming a local-service oracle.
 */

import { describe, it, expect, afterEach } from 'vitest'
import { request } from 'node:http'
import { bindLoopback, MAX_CALLBACK_BYTES, type CallbackListener } from '../src/out-of-band/listener.ts'
import type { CallbackPlan } from '../src/out-of-band/contract.ts'
import { PROBE_HEADER } from '../src/login-status.ts'

/** Listeners opened by a test, closed after it whatever happened. */
const opened: Array<{ close: () => void }> = []

afterEach(() => {
  for (const listener of opened.splice(0)) listener.close()
})

/** The plan one provider actually returns, as the live service reports it. */
const PLAN = {
  address: '',
  path: '/',
  method: 'POST',
  content_type: 'application/json',
  allow_origins: [
    'https://devstation.connect.huaweicloud.com',
    'https://devstation.connect.huaweicloud.cn',
    'https://devstation.developer.huaweicloud.com',
  ],
  requires_private_network_access: true,
  correlation: 'none',
} satisfies CallbackPlan

const PROBE = { path: '/__aishell_probe', nonce: 'probe-nonce-1234' }

/**
 * Bind a listener serving the plan above, and register it for cleanup.
 *
 * `plan` is typed as the plan interface rather than inferred from `PLAN`, so a
 * case can vary one field — a plan that does not require private-network
 * access, say — without the others' literal types constraining it.
 */
async function serve(
  plan: CallbackPlan = { ...PLAN, address: '' },
  probe: typeof PROBE | undefined = PROBE,
): Promise<{
  listener: ReturnType<Awaited<ReturnType<typeof bindLoopback>>['serve']>
  address: string
}> {
  const bound = await bindLoopback()
  opened.push(bound)
  // The plan's own address is what the caller would have checked against the
  // bound one; here the port is OS-assigned, so the plan carries it forward.
  const listener = bound.serve({ ...plan, address: bound.address }, probe)
  opened.push(listener)
  return { listener, address: bound.address }
}

/** One HTTP exchange against the listener, resolving with status and headers. */
function send(
  address: string,
  options: {
    method: string
    path: string
    headers?: Record<string, string>
    body?: string
  },
): Promise<{ status: number, headers: Record<string, string | string[] | undefined> }> {
  return new Promise((resolve, reject) => {
    const [host, port] = address.split(':')
    const req = request({
      host,
      port: Number(port),
      method: options.method,
      path: options.path,
      headers: options.headers ?? {},
    }, (response) => {
      response.resume()
      response.on('end', () => {
        resolve({ status: response.statusCode ?? 0, headers: response.headers })
      })
    })
    req.on('error', reject)
    if (options.body !== undefined) req.write(options.body)
    req.end()
  })
}

describe('callback listener — the preflight the browser will not proceed without', () => {
  it('echoes the one origin that matched, never the list', async () => {
    const { address } = await serve()

    const response = await send(address, {
      method: 'OPTIONS',
      path: '/',
      headers: {
        origin: 'https://devstation.connect.huaweicloud.com',
        'access-control-request-method': 'POST',
      },
    })

    // A response header takes a single value. Echoing the list would be
    // rejected by the browser, and writing `*` would let any page post a
    // forged credential here.
    expect(response.headers['access-control-allow-origin'])
      .toBe('https://devstation.connect.huaweicloud.com')
    expect(response.headers.vary).toBe('Origin')
  })

  it('matches each of the provider origins exactly', async () => {
    const { address } = await serve()

    for (const origin of PLAN.allow_origins) {
      // eslint-disable-next-line no-await-in-loop
      const response = await send(address, {
        method: 'OPTIONS',
        path: '/',
        headers: { origin, 'access-control-request-method': 'POST' },
      })
      expect(response.headers['access-control-allow-origin']).toBe(origin)
    }
  })

  it('refuses origins that merely resemble an allowed one', async () => {
    const { address } = await serve()

    const impostors = [
      'https://devstation.connect.huaweicloud.com.evil.com',
      'https://evil-devstation.connect.huaweicloud.com',
      'http://devstation.connect.huaweicloud.com',
      'https://DEVSTATION.CONNECT.HUAWEICLOUD.COM',
      'null',
    ]

    for (const origin of impostors) {
      // eslint-disable-next-line no-await-in-loop
      const response = await send(address, {
        method: 'OPTIONS',
        path: '/',
        headers: { origin, 'access-control-request-method': 'POST' },
      })
      expect(response.headers['access-control-allow-origin']).toBeUndefined()
    }
  })

  it('sends the private-network allow header when the plan says the callback needs it', async () => {
    const { address } = await serve()

    const response = await send(address, {
      method: 'OPTIONS',
      path: '/',
      headers: {
        origin: 'https://devstation.connect.huaweicloud.com',
        'access-control-request-method': 'POST',
        'access-control-request-private-network': 'true',
      },
    })

    // Without this the browser drops the real request, and the symptom is a
    // login page that spins forever — visible only in a real browser.
    expect(response.headers['access-control-allow-private-network']).toBe('true')
  })

  it('does not grant private-network access to a client that did not ask', async () => {
    const { address } = await serve()

    const response = await send(address, {
      method: 'OPTIONS',
      path: '/',
      headers: {
        origin: 'https://devstation.connect.huaweicloud.com',
        'access-control-request-method': 'POST',
      },
    })

    expect(response.headers['access-control-allow-private-network']).toBeUndefined()
  })

  it('does not grant it when the plan does not require it', async () => {
    // A provider whose callback is not a public-page-to-loopback request must
    // not be told the weaker rule is in force.
    const { address } = await serve({ ...PLAN, requires_private_network_access: false })

    const response = await send(address, {
      method: 'OPTIONS',
      path: '/',
      headers: {
        origin: 'https://devstation.connect.huaweicloud.com',
        'access-control-request-method': 'POST',
        'access-control-request-private-network': 'true',
      },
    })

    expect(response.headers['access-control-allow-private-network']).toBeUndefined()
  })
})

describe('callback listener — accepting the credential', () => {
  it('accepts a post on the plan path from an allowed origin', async () => {
    const { listener, address } = await serve()

    const response = await send(address, {
      method: 'POST',
      path: '/',
      headers: { origin: 'https://devstation.connect.huaweicloud.com', 'content-type': 'application/json' },
      body: JSON.stringify({ access: 'AK', secret: 'SK', securitytoken: 'TOKEN' }),
    })

    expect(response.status).toBe(200)
    await expect(listener.accepted).resolves.toEqual({ access: 'AK', secret: 'SK', securitytoken: 'TOKEN' })
  })

  it('rejects a post to a path the plan does not name', async () => {
    const { address } = await serve()

    const response = await send(address, {
      method: 'POST',
      path: '/somewhere-else',
      headers: { origin: 'https://devstation.connect.huaweicloud.com' },
      body: '{}',
    })

    expect(response.status).toBe(404)
  })

  it('refuses a post with no origin when the plan names origins', async () => {
    // A local process posting without an Origin is not the cloud's callback.
    const { address } = await serve()

    const response = await send(address, {
      method: 'POST',
      path: '/',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ access: 'AK', secret: 'SK' }),
    })

    expect(response.status).toBe(403)
  })

  it('refuses a post from an origin the plan does not allow', async () => {
    const { address } = await serve()

    const response = await send(address, {
      method: 'POST',
      path: '/',
      headers: { origin: 'https://evil.example.com', 'content-type': 'application/json' },
      body: JSON.stringify({ access: 'AK', secret: 'SK' }),
    })

    expect(response.status).toBe(403)
  })

  it('does not let a second post overwrite the first', async () => {
    const { listener, address } = await serve()
    const origin = 'https://devstation.connect.huaweicloud.com'

    await send(address, {
      method: 'POST',
      path: '/',
      headers: { origin, 'content-type': 'application/json' },
      body: JSON.stringify({ access: 'FIRST', secret: 'SK' }),
    })

    // The listener has closed itself by now, so the second post cannot even be
    // delivered. That is the point: the port stops answering once a credential
    // has landed.
    await expect(send(address, {
      method: 'POST',
      path: '/',
      headers: { origin, 'content-type': 'application/json' },
      body: JSON.stringify({ access: 'SECOND', secret: 'SK' }),
    })).rejects.toBeDefined()

    await expect(listener.accepted).resolves.toEqual({ access: 'FIRST', secret: 'SK' })
  })

  it('rejects a body past the size bound', async () => {
    const { address } = await serve()
    const origin = 'https://devstation.connect.huaweicloud.com'

    const response = await send(address, {
      method: 'POST',
      path: '/',
      headers: { origin, 'content-type': 'application/json' },
      // The port is reachable by any local process, so an unbounded read is a
      // memory-growth handle.
      body: JSON.stringify({ padding: 'x'.repeat(MAX_CALLBACK_BYTES + 1024) }),
    })

    expect(response.status).toBe(400)
  })

  it('rejects a body that is not JSON', async () => {
    const { address } = await serve()

    const response = await send(address, {
      method: 'POST',
      path: '/',
      headers: { origin: 'https://devstation.connect.huaweicloud.com' },
      body: 'not json at all',
    })

    expect(response.status).toBe(400)
  })
})

describe('callback listener — the reachability probe', () => {
  it('answers the probe when the nonce matches', async () => {
    const { address } = await serve()

    const response = await send(address, { method: 'GET', path: `${PROBE.path}?n=${PROBE.nonce}` })

    expect(response.status).toBe(204)
  })

  it('advertises the probe header, so the preflight the probe triggers passes', async () => {
    // The probe sends a custom header on purpose: that is what forces a CORS
    // preflight, which is the step the cloud's JSON POST also always takes. If
    // this answer omits the header, the browser blocks the probe — and the
    // entry disappears on a route that would have worked.
    const { address } = await serve()

    const response = await send(address, {
      method: 'OPTIONS',
      path: `${PROBE.path}?n=${PROBE.nonce}`,
      headers: {
        origin: 'http://127.0.0.1:8080',
        'access-control-request-method': 'GET',
        'access-control-request-headers': PROBE_HEADER,
      },
    })

    expect(response.status).toBe(204)
    expect(response.headers['access-control-allow-headers']).toBe(PROBE_HEADER)
    expect(response.headers['access-control-allow-origin']).toBe('http://127.0.0.1:8080')
  })

  it('answers a cross-origin probe with the caller origin echoed', async () => {
    const { address } = await serve()

    const response = await send(address, {
      method: 'GET',
      path: `${PROBE.path}?n=${PROBE.nonce}`,
      headers: { origin: 'http://127.0.0.1:8080' },
    })

    // The page's own origin is never one of the cloud's, so the probe can only
    // be read cross-origin.
    expect(response.status).toBe(204)
    expect(response.headers['access-control-allow-origin']).toBe('http://127.0.0.1:8080')
  })

  it('hides behind a 404 without the nonce', async () => {
    // Without this, any page that swept local ports would learn that this one
    // answers — a fingerprinting beacon for the plugin's presence.
    const { address } = await serve()

    expect((await send(address, { method: 'GET', path: PROBE.path })).status).toBe(404)
    expect((await send(address, { method: 'GET', path: `${PROBE.path}?n=wrong` })).status).toBe(404)
  })

  it('does not accept a nonce-matching POST as a credential', async () => {
    // The probe path must never be a way in, whatever the method.
    const { address } = await serve()
    const origin = 'https://devstation.connect.huaweicloud.com'

    const response = await send(address, {
      method: 'POST',
      path: `${PROBE.path}?n=${PROBE.nonce}`,
      headers: { origin, 'content-type': 'application/json' },
      body: JSON.stringify({ access: 'AK', secret: 'SK' }),
    })

    expect(response.status).toBe(404)
  })
})

describe('callback listener — lifecycle', () => {
  it('binds before any plan is known, and refuses to serve until one arrives', async () => {
    const bound = await bindLoopback()
    opened.push(bound)

    // Nothing can reach this port yet — the URL naming it has not been handed
    // to anyone — so a request here is stray rather than a race.
    expect(bound.address).toMatch(/^127\.0\.0\.1:\d+$/)
    const response = await send(bound.address, { method: 'POST', path: '/', body: '{}' })
    expect(response.status).toBe(503)
  })

  it('releases the port when closed', async () => {
    const { listener, address } = await serve()
    listener.close()

    await expect(send(address, { method: 'GET', path: `${PROBE.path}?n=${PROBE.nonce}` }))
      .rejects.toBeDefined()
  })

  it('closes itself once a credential has been accepted', async () => {
    const { listener, address } = await serve()

    await send(address, {
      method: 'POST',
      path: '/',
      headers: { origin: 'https://devstation.connect.huaweicloud.com', 'content-type': 'application/json' },
      body: JSON.stringify({ access: 'AK', secret: 'SK' }),
    })
    await listener.accepted

    // Narrowing the replay window is the reason: the credential is in hand, so
    // there is nothing left for this port to do.
    await expect(send(address, { method: 'GET', path: `${PROBE.path}?n=${PROBE.nonce}` }))
      .rejects.toBeDefined()
  })

  it('tolerates close being called twice', async () => {
    const { listener } = await serve()
    listener.close()
    expect(() => { listener.close() }).not.toThrow()
  })
})

/** A listener variable kept in scope so its type is exercised. */
export type { CallbackListener }
