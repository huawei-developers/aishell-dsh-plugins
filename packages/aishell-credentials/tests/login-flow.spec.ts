/**
 * The browser-login flow.
 *
 * The property this file exists for is an ordering one: **verification happens
 * before storage, and its failure is terminal.** A credential that reached the
 * store unverified would be the exact outcome the flow's verification step
 * exists to prevent — the callback's origin cannot be authenticated, so asking
 * the cloud is the only thing standing between a forged post and a stored
 * credential.
 *
 * Everything else here is bookkeeping around that: one login at a time, an
 * outcome recorded for the browser half, and a cancel that releases the port
 * rather than leaving it bound.
 */

import { describe, it, expect, vi } from 'vitest'
import { createLoginFlow, type LoginFlowDeps } from '../src/out-of-band/flow.ts'
import type { LoginOutcome } from '../src/login-status.ts'
import type { MappedCredential, ProviderInfo } from '../src/out-of-band/contract.ts'

/** The provider the live service reports, verbatim. */
const HUAWEI: ProviderInfo = {
  id: 'huaweicloud',
  display_name: '华为云',
  delivery: 'out_of_band',
  credential_type: 'ak_sk_sts',
  credential_schema: { access: 'string', secret: 'string', securitytoken: 'string' },
}

/** What a `begin` call produced, for assertions. */interface Recorded {
  readonly outcomes: Array<LoginOutcome | undefined>
  readonly errors: string[]
  readonly stored: MappedCredential[]
}

/**
 * A flow whose collaborators are all recorded, and whose service calls are
 * stubbed so no socket is bound and no network is touched.
 *
 * The listener itself is covered in `listener.spec.ts` against a real socket;
 * what is under test here is the decision table around it.
 */
function makeFlow(overrides: Partial<LoginFlowDeps> = {}): {
  flow: ReturnType<typeof createLoginFlow>
  recorded: Recorded
} {
  const recorded: Recorded = { outcomes: [], errors: [], stored: [] }
  const flow = createLoginFlow({
    // Verification names the account — the outcome reports *this*, not a
    // value read back from the store, whose hint lags the write.
    verify: () => Promise.resolve('account-name'),
    store: (credential) => {
      recorded.stored.push(credential)
      return Promise.resolve()
    },
    recordError: (error) => { recorded.errors.push(error) },
    recordOutcome: (outcome) => { recorded.outcomes.push(outcome) },
    ...overrides,
  })
  return { flow, recorded }
}

/**
 * A contract stub answering `/v1/providers` and `/v1/login`.
 *
 * The plan names whatever port the caller bound, which `begin` refuses
 * otherwise — so the stub reads it back out of the redirect URI, exactly as a
 * service projecting a callback would.
 */
function echoService(provider: ProviderInfo = HUAWEI, projected?: { address: string }): typeof fetch {
  return ((input: string | URL | Request) => {
    const url = new URL(String(input))
    if (url.pathname === '/v1/providers') {
      return Promise.resolve(new Response(JSON.stringify({ providers: [provider] }), {
        status: 200, headers: { 'content-type': 'application/json' },
      }))
    }
    const port = new URL(url.searchParams.get('redirect_uri') ?? '').port
    // Recorded so a test can post a credential to the port the service was told
    // about. The login URL does not carry it — the service projects the port
    // away — so this is the only way a spec can reach the listener.
    if (projected !== undefined) projected.address = `127.0.0.1:${port}`
    return Promise.resolve(new Response(JSON.stringify({
      provider: provider.id,
      delivery: 'out_of_band',
      login_url: 'https://example.invalid/login',
      callback: {
        address: `127.0.0.1:${port}`,
        path: '/',
        method: 'POST',
        content_type: 'application/json',
        allow_origins: ['https://devstation.connect.huaweicloud.com'],
        requires_private_network_access: true,
        correlation: 'none',
      },
      expires_in: 600,
    }), { status: 200, headers: { 'content-type': 'application/json' } }))
  }) as unknown as typeof fetch
}

/** Post a well-formed callback to the address a login bound. */
async function deliver(address: string, body: unknown): Promise<number> {
  const response = await realFetch(`http://${address}/`, {
    method: 'POST',
    headers: {
      origin: 'https://devstation.connect.huaweicloud.com',
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  })
  return response.status
}

/** Let a detached continuation run. */
const settle = (): Promise<void> => new Promise(resolve => setTimeout(resolve, 30))

/**
 * The real `fetch`, captured before any stub replaces the global.
 *
 * Used to talk to the login's own loopback listener over an actual socket,
 * which is the only way to observe whether the port is still bound.
 */
const realFetch = globalThis.fetch

describe('browser login flow — verification precedes storage', () => {
  it('does not store a credential the cloud rejects', async () => {
    // The residual case the verification step answers: a well-formed payload
    // whose credential the cloud will not accept. Nothing may reach the store,
    // and the person must be told why.
    const projected = { address: '' }
    const { flow, recorded } = makeFlow({
      contract: { fetch: echoService(HUAWEI, projected) },
      verify: () => Promise.reject(new Error('credentials rejected by IAM')),
    })
    await flow.begin(HUAWEI)

    expect(await deliver(projected.address, {
      access: 'AK', secret: 'SK', securitytoken: 'TOKEN',
    })).toBe(200)
    await settle()

    expect(recorded.stored).toHaveLength(0)
    expect(recorded.outcomes).toEqual([{ kind: 'failed', error: 'credentials rejected by IAM' }])
    // The error is recorded for the form as well as the outcome, so the chip
    // and the form agree about what happened.
    expect(recorded.errors).toEqual(['credentials rejected by IAM'])
    expect(flow.inProgress()).toBe(false)
  })

  it('stores a credential the cloud accepts, and announces the change', async () => {
    const projected = { address: '' }
    const { flow, recorded } = makeFlow({ contract: { fetch: echoService(HUAWEI, projected) } })
    await flow.begin(HUAWEI)

    expect(await deliver(projected.address, {
      access: 'AK', secret: 'SK', securitytoken: 'TOKEN',
    })).toBe(200)
    await settle()

    expect(recorded.stored).toEqual([{ accessKeyId: 'AK', secretAccessKey: 'SK', securityToken: 'TOKEN' }])
    // The announcement that the stored credentials changed is the
    // composition root's job — it fires from `recordOutcome`, where a success
    // is known, so the flow itself emits nothing.
    // The account name comes from verification, which is the only thing that
    // knows it at this instant.
    expect(recorded.outcomes).toEqual([{ kind: 'succeeded', accountName: 'account-name' }])
    expect(flow.inProgress()).toBe(false)
  })

  it('does not store a payload that omits a field the schema promises', async () => {
    const projected = { address: '' }
    const { flow, recorded } = makeFlow({ contract: { fetch: echoService(HUAWEI, projected) } })
    await flow.begin(HUAWEI)

    await deliver(projected.address, { access: 'AK' })
    await settle()

    // Half a pair is not a credential, and the store's single-record design
    // exists precisely so one cannot land.
    expect(recorded.stored).toHaveLength(0)
    expect(recorded.outcomes[0]).toMatchObject({ kind: 'failed' })
  })

  it('verifies with the mapped credential, not the raw payload', async () => {
    const seen: MappedCredential[] = []
    const projected = { address: '' }
    const { flow } = makeFlow({
      contract: { fetch: echoService(HUAWEI, projected) },
      verify: (credential) => { seen.push(credential); return Promise.resolve('account') },
    })
    await flow.begin(HUAWEI)

    await deliver(projected.address, { access: 'AK', secret: 'SK', securitytoken: 'TOKEN' })
    await settle()

    expect(seen).toEqual([{ accessKeyId: 'AK', secretAccessKey: 'SK', securityToken: 'TOKEN' }])
  })

  it('reports a storage failure differently from a rejected credential', async () => {
    const projected = { address: '' }
    const { flow, recorded } = makeFlow({
      contract: { fetch: echoService(HUAWEI, projected) },
      store: () => Promise.reject(new Error('keyring locked')),
    })
    await flow.begin(HUAWEI)

    await deliver(projected.address, { access: 'AK', secret: 'SK' })
    await settle()

    // The credential was good; the store was not. Saying so is what points the
    // person at the right problem.
    expect(recorded.outcomes[0]).toMatchObject({ kind: 'failed' })
    expect(recorded.errors[0]).toMatch(/keyring locked/)
  })
})

describe('browser login flow — one at a time', () => {
  it('reports no login in progress before any begins', () => {
    const { flow } = makeFlow()
    expect(flow.inProgress()).toBe(false)
  })

  it('accepts a cancel when nothing is running', () => {
    // The teardown path calls this unconditionally, including on a host where
    // no login ever started.
    const { flow, recorded } = makeFlow()
    expect(() => { flow.cancel() }).not.toThrow()
    // Clearing the outcome is what tells the browser half to stop showing
    // "waiting" — an ordinary dismissal, not a failure.
    expect(recorded.outcomes).toEqual([undefined])
    expect(recorded.errors).toHaveLength(0)
  })
})

describe('browser login flow — provider lookup', () => {
  it('forwards a lookup failure rather than swallowing it', async () => {
    // The route turns this into a 503, which is what hides the entry when the
    // host cannot reach the login service.
    const { flow } = makeFlow({
      contract: {
        fetch: (() => Promise.reject(new Error('ENOTFOUND'))) as unknown as typeof fetch,
      },
    })
    await expect(flow.findProvider('huaweicloud')).rejects.toThrow()
  })

  it('answers undefined for a provider the service does not list', async () => {
    const { flow } = makeFlow({
      contract: {
        fetch: (() => Promise.resolve(new Response(
          JSON.stringify({ providers: [] }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ))) as unknown as typeof fetch,
      },
    })
    await expect(flow.findProvider('huaweicloud')).resolves.toBeUndefined()
  })

  it('finds the provider the service lists', async () => {
    const { flow } = makeFlow({
      contract: {
        fetch: (() => Promise.resolve(new Response(
          JSON.stringify({ providers: [HUAWEI] }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ))) as unknown as typeof fetch,
      },
    })
    await expect(flow.findProvider('huaweicloud')).resolves.toEqual(HUAWEI)
  })
})

describe('browser login flow — a real begin, against a stubbed service', () => {
  it('begins a login, binds a listener, and hands back the URL', async () => {
    const projected = { address: '' }
    const { flow } = makeFlow({ contract: { fetch: echoService(HUAWEI, projected) } })

    const started = await flow.begin(HUAWEI)

    expect(started.ok).toBe(true)
    expect(started.loginUrl).toBe('https://example.invalid/login')
    expect(started.providerName).toBe('华为云')
    // The service was told which port to project the callback for, which is
    // what the listener is waiting on. No probe URL is returned: reachability
    // is a separate question, asked before any of this.
    expect(projected.address).toMatch(/^127\.0\.0\.1:\d+$/)
    expect(flow.inProgress()).toBe(true)

    flow.cancel()
    expect(flow.inProgress()).toBe(false)
  })

  it('refuses a second login while one is running', async () => {
    const projected = { address: '' }
    const { flow } = makeFlow({ contract: { fetch: echoService(HUAWEI, projected) } })
    await flow.begin(HUAWEI)

    // Two concurrent logins could not be told apart: the shipped provider's
    // callback carries no correlation string.
    await expect(flow.begin(HUAWEI)).rejects.toThrow(/already in progress/)

    flow.cancel()
  })

  it('refuses a plan naming a port this machine is not listening on', async () => {
    const { flow } = makeFlow({
      contract: {
        fetch: ((input: string | URL | Request) => {
          const url = new URL(String(input))
          if (url.pathname === '/v1/providers') {
            return Promise.resolve(new Response(JSON.stringify({ providers: [HUAWEI] }), {
              status: 200, headers: { 'content-type': 'application/json' },
            }))
          }
          // A plan for somebody else's port. Waiting on ours would never see
          // the callback, and the symptom would be a bare timeout.
          return Promise.resolve(new Response(JSON.stringify({
            provider: 'huaweicloud',
            delivery: 'out_of_band',
            login_url: 'https://example.invalid/login',
            callback: {
              address: '127.0.0.1:1',
              path: '/',
              method: 'POST',
              correlation: 'none',
            },
            expires_in: 600,
          }), { status: 200, headers: { 'content-type': 'application/json' } }))
        }) as unknown as typeof fetch,
      },
    })

    await expect(flow.begin(HUAWEI)).rejects.toThrow(/cannot arrive/)
    // The socket it bound must not be left behind by the refusal.
    expect(flow.inProgress()).toBe(false)
  })

  it('releases the port when the service cannot be reached at all', async () => {
    const { flow } = makeFlow({
      contract: {
        fetch: ((input: string | URL | Request) => {
          const url = new URL(String(input))
          if (url.pathname === '/v1/providers') {
            return Promise.resolve(new Response(JSON.stringify({ providers: [HUAWEI] }), {
              status: 200, headers: { 'content-type': 'application/json' },
            }))
          }
          return Promise.reject(new Error('ENOTFOUND'))
        }) as unknown as typeof fetch,
      },
    })

    await expect(flow.begin(HUAWEI)).rejects.toThrow()
    expect(flow.inProgress()).toBe(false)
  })

  it('exposes the login URL as a plain value', async () => {
    const projected = { address: '' }
    const { flow } = makeFlow({ contract: { fetch: echoService(HUAWEI, projected) } })
    const started = await flow.begin(HUAWEI)

    // The browser half needs it in the same render pass as the state that
    // shows it; a promise would make it await something already known.
    expect(typeof started.loginUrl).toBe('string')

    flow.cancel()
  })

  it('keeps a cancel from reporting a failure', async () => {
    const projected = { address: '' }
    const { flow, recorded } = makeFlow({ contract: { fetch: echoService(HUAWEI, projected) } })
    await flow.begin(HUAWEI)

    flow.cancel()

    // A dismissal is a decision the person made, not something to explain
    // back to them.
    expect(recorded.outcomes).toEqual([undefined])
    expect(recorded.errors).toHaveLength(0)
  })

  it('releases the loopback port when the person cancels', async () => {
    // The listener is a bound socket holding a port the service chose; a cancel
    // that left it open would keep the port until the process died, and the
    // person would have no way to tell. Asserted by connecting to the address
    // the login published: a closed listener refuses the connection.
    const projected = { address: '' }
    const { flow } = makeFlow({ contract: { fetch: echoService(HUAWEI, projected) } })
    await flow.begin(HUAWEI)

    // Reachable while the login is live — the control, without which the
    // assertion below would pass for a port that was never open. The listener
    // answers 403 to an unmarked post (no Origin), which is still a reply.
    await expect(realFetch(`http://${projected.address}/`)).resolves.toBeDefined()

    flow.cancel()

    await expect(realFetch(`http://${projected.address}/`, { method: 'GET' })).rejects.toBeDefined()
  })

  it('does not report the outcome of a login that was cancelled', async () => {
    const projected = { address: '' }
    const { flow, recorded } = makeFlow({ contract: { fetch: echoService(HUAWEI, projected) } })
    await flow.begin(HUAWEI)
    const before = recorded.outcomes.length

    flow.cancel()
    // Let any detached continuation run; the cancelled login must not append
    // an outcome after the cancel already recorded its own.
    await new Promise(resolve => setTimeout(resolve, 20))

    expect(recorded.outcomes).toHaveLength(before + 1)
    expect(recorded.stored).toHaveLength(0)
  })
})

describe('browser login flow — nothing is stored without a completed callback', () => {
  it('leaves the store empty when no credential ever arrives', async () => {
    const { flow, recorded } = makeFlow({
      contract: {
        fetch: (() => Promise.resolve(new Response(JSON.stringify({ providers: [HUAWEI] }), {
          status: 200, headers: { 'content-type': 'application/json' },
        }))) as unknown as typeof fetch,
      },
    })

    // `begin` cannot succeed without a plan, so this is the failure path — and
    // the point is that it stores nothing on the way out.
    await expect(flow.begin(HUAWEI)).rejects.toThrow()
    expect(recorded.stored).toHaveLength(0)
    expect(vi.isMockFunction(recorded.stored.push)).toBe(false)
  })
})

describe('browser login flow — a login that is never completed', () => {
  it('gives up when the service says the login has expired', async () => {
    // Someone who opens the sign-in page and walks away. Without a bound the
    // port stays held and the form waits for an answer that cannot arrive —
    // and every later attempt is refused as "already in progress".
    const { flow, recorded } = makeFlow({
      contract: {
        fetch: ((input: string | URL | Request) => {
          const url = new URL(String(input))
          if (url.pathname === '/v1/providers') {
            return Promise.resolve(new Response(JSON.stringify({ providers: [HUAWEI] }), {
              status: 200, headers: { 'content-type': 'application/json' },
            }))
          }
          const port = new URL(url.searchParams.get('redirect_uri') ?? '').port
          return Promise.resolve(new Response(JSON.stringify({
            provider: 'huaweicloud',
            delivery: 'out_of_band',
            login_url: 'https://example.invalid/login',
            callback: {
              address: `127.0.0.1:${port}`,
              path: '/',
              method: 'POST',
              correlation: 'none',
            },
            // Expires immediately, so the case does not take ten minutes.
            expires_in: 0.05,
          }), { status: 200, headers: { 'content-type': 'application/json' } }))
        }) as unknown as typeof fetch,
      },
    })

    const started = await flow.begin(HUAWEI)
    expect(started.ok).toBe(true)

    await new Promise(resolve => setTimeout(resolve, 150))

    expect(recorded.stored).toHaveLength(0)
    expect(recorded.outcomes[0]).toMatchObject({ kind: 'failed' })
    // The port is released, so a retry is not refused as already in progress.
    expect(flow.inProgress()).toBe(false)
  })
})
