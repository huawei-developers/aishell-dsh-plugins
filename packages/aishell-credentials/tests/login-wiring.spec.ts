/**
 * What a completed browser login does to the tool call that asked for it.
 *
 * This file exists for one bug, which the UI alone cannot reveal. The card is
 * up because `aishell__auth` is blocked on a form request. The browser half
 * closing the card only withdraws the *interaction* — it does not reach the
 * tool. So a login that stored a credential without settling that request left
 * the call waiting until the turn ended: the person sees success, and the agent
 * never continues.
 *
 * The wiring under test is `apply()`, driven the way the browser half drives
 * it: a login started over the route, a credential posted to the callback
 * listener, and the outcome the host records.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'

/** Ops written through `settings.mutate`, in order. */
let mutateCalls: Array<Array<{ op: string, path: string[], value?: unknown }>> = []
/** Routes registered through the stubbed connection, by path. */
let routes: Map<string, (request: Request) => Promise<Response>>

/** The `requestForm` dependency apply() hands the tool. */
let requestForm: ((sessionId: string) => Promise<unknown> | undefined) | undefined
/** The `releaseForm` dependency apply() hands the tool. */
let releaseForm: (() => void) | undefined

vi.mock('../src/auth-tool.ts', () => ({
  AUTH_TOOL_NAME: 'aishell__auth',
  registerAuthTool: (
    _ctx: unknown,
    _store: unknown,
    deps: { requestForm: typeof requestForm, releaseForm: typeof releaseForm },
  ) => {
    requestForm = deps.requestForm
    releaseForm = deps.releaseForm
  },
}))

// IAM verification is stubbed at the module boundary: this file is about what
// happens *after* a credential verifies, and a real call would need credentials
// and a network.
vi.mock('@huaweidevtools/aishell-dsh-credentials-store/verify', () => ({
  verifyCredentials: () => Promise.resolve({
    ok: true,
    account: { accountId: 'acct-1', name: 'the-account', projects: [] },
    sts: false,
  }),
}))

const { apply } = await import('../src/index.ts')

/** A ctx covering exactly what apply() touches. */
function makeCtx() {
  return {
    fiber: { entry: { options: { id: 'aishell-client-credentials' } } },
    logger: () => ({ info() {}, warn() {}, error() {} }),
    settings: {
      mutate: (ns: string, ops: Array<{ op: string, path: string[], value?: unknown }>) => {
        void ns
        mutateCalls.push(ops)
        return Promise.resolve()
      },
      configure() {},
    },
    connection: {
      fetch: {
        register: (entry: { path: string, fetch: (request: Request) => Promise<Response> }) => {
          routes.set(entry.path, entry.fetch)
          return () => {}
        },
      },
    },
    effect: (fn: () => unknown) => { fn(); return () => {} },
    on: () => () => {},
    emit() {},
    get: () => undefined,
    inject() {},
  }
}

/** A Config-shaped object with every field apply() reads. */
const config = {
  credentialsStored: { get: () => false },
  accessKeyIdHint: { get: () => '' },
  lastError: { get: () => '' },
  credentialFormRequest: { get: () => '' },
  loginOutcome: { get: () => '' },
}

/** Mount the plugin and return the captured `requestForm`. */
function mount(): (sessionId: string) => Promise<unknown> | undefined {
  apply(makeCtx() as never, config as never)
  if (requestForm === undefined) throw new Error('the auth tool was not registered')
  return requestForm
}

/** POST one JSON body to a registered route. */
function post(path: string, body?: unknown): Promise<Response> {
  const handler = routes.get(path)
  if (handler === undefined) throw new Error(`no route registered at ${path}`)
  return handler(new Request(`http://x${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  }))
}

beforeEach(() => {
  mutateCalls = []
  routes = new Map()
  requestForm = undefined
  releaseForm = undefined
})

/**
 * A contract stub whose plan names the port the caller actually bound.
 *
 * The host refuses a plan naming any other address, so the stub reads the port
 * back out of the redirect URI — which is what a service projecting a callback
 * does.
 */
function stubContract(): { projected: { address: string } } {
  const projected = { address: '' }
  vi.stubGlobal('fetch', (input: string | URL | Request) => {
    const url = new URL(String(input))
    // The port the service was told to project the callback onto. Recorded so a
    // test can post a credential to the listener; the login URL does not carry
    // it, because the service projects the port away.
    if (url.pathname !== '/v1/providers') {
      projected.address = `127.0.0.1:${new URL(url.searchParams.get('redirect_uri') ?? '').port}`
    }
    const body = url.pathname === '/v1/providers'
      ? {
        providers: [{
          id: 'huaweicloud',
          display_name: '华为云',
          delivery: 'out_of_band',
          credential_type: 'ak_sk_sts',
          credential_schema: { access: 'string', secret: 'string', securitytoken: 'string' },
        }],
      }
      : {
        provider: 'huaweicloud',
        delivery: 'out_of_band',
        login_url: 'https://example.invalid/login',
        callback: {
          address: projected.address,
          path: '/',
          method: 'POST',
          content_type: 'application/json',
          allow_origins: ['https://devstation.connect.huaweicloud.com'],
          requires_private_network_access: true,
          correlation: 'none',
        },
        expires_in: 600,
      }
    return Promise.resolve(new Response(JSON.stringify(body), {
      status: 200, headers: { 'content-type': 'application/json' },
    }))
  })
  return { projected }
}

/**
 * The real `fetch`, captured before any stub replaces the global.
 *
 * `deliver` talks to the callback listener over a real socket, so it must not
 * go through the contract stub — which is why the genuine implementation is
 * held here rather than looked up at call time.
 */
const realFetch = globalThis.fetch

/** Deliver a credential to the address a login bound. */
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

/** Let the detached continuation that stores the credential run. */
const settle = (): Promise<void> => new Promise(resolve => setTimeout(resolve, 40))

describe('a completed browser login releases the blocked tool call', () => {
  it('settles the pending form request, not just the card', async () => {
    const { projected } = stubContract()
    const open = mount()

    // A tool call blocks on the form, which is why the card is on screen.
    const pending = open('session-1')
    expect(pending).toBeDefined()

    await post('/api/aishell/credentials/login/start')
    expect(await deliver(projected.address, {
      access: 'AK', secret: 'SK', securitytoken: 'TOKEN',
    })).toBe(200)
    await settle()

    // The bug: this stayed pending. The credential was stored and the card
    // withdrawn, but the call that asked for it waited until the turn ended.
    await expect(pending).resolves.toEqual({ kind: 'submitted' })

    vi.unstubAllGlobals()
  })

  it('records a success the browser half can read', async () => {
    const { projected } = stubContract()
    mount()
    await post('/api/aishell/credentials/login/start')
    await deliver(projected.address, { access: 'AK', secret: 'SK' })
    await settle()

    const recorded = mutateCalls
      .flat()
      .filter(op => op.path[0] === 'loginOutcome')
      .map(op => op.value)
    expect(recorded.some(value => typeof value === 'string' && value.includes('succeeded'))).toBe(true)

    vi.unstubAllGlobals()
  })

  it('leaves the call pending when the login fails', async () => {
    // A failure is not an answer: the person may switch to pasting a key, and
    // neither route has been refused. Settling here would tell the model the
    // user declined something they never saw.
    const { projected } = stubContract()
    const open = mount()
    const pending = open('session-1')

    await post('/api/aishell/credentials/login/start')
    // A payload missing a field the schema promises: the login fails.
    await deliver(projected.address, { access: 'AK' })
    await settle()

    let settled = false
    void (pending as Promise<unknown>).then(() => { settled = true })
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(settled).toBe(false)

    vi.unstubAllGlobals()
  })
})

describe('a stopped turn releases the login listener', () => {
  it('closes the port when the turn is stopped with the login waiting', async () => {
    // The person is on the waiting page and stops the turn. Their browser half
    // goes with it, so nothing will ever post the cancel route — the socket
    // would stay bound for the life of the process, and every later `auth`
    // would find the port still held. The tool's release has to free it.
    const { projected } = stubContract()
    const open = mount()

    const pending = open('session-1')
    await post('/api/aishell/credentials/login/start')

    // Reachable while the login is live — the control, without which the
    // assertion below would pass for a port that was never open.
    await expect(realFetch(`http://${projected.address}/`)).resolves.toBeDefined()

    // The tool calls this when it stops waiting — a stopped turn is the case
    // that reaches it, and the tool's own spec covers that trigger. What is
    // under test here is what the host does with it.
    releaseForm?.()
    await expect(pending).resolves.toEqual({ kind: 'cancelled' })

    await expect(realFetch(`http://${projected.address}/`)).rejects.toBeDefined()

    vi.unstubAllGlobals()
  })
})

describe('a completed login records the status the chip reads', () => {
  it('sets credentialsStored and the account name, not just the outcome', async () => {
    // The chip's label and its "configured" test both key off `accessKeyIdHint`
    // — not off the login outcome. A login that recorded only the outcome left
    // the chip reading "no credentials" over an authenticated account, until
    // the reconcile loop happened to tick up to thirty seconds later.
    const { projected } = stubContract()
    mount()
    await post('/api/aishell/credentials/login/start')
    await deliver(projected.address, { access: 'AK', secret: 'SK' })
    await settle()

    const ops = mutateCalls.flat()
    const stored = ops.find(op => op.path[0] === 'credentialsStored' && op.op === 'set')
    const hint = ops.find(op => op.path[0] === 'accessKeyIdHint' && op.op === 'set')

    expect(stored?.value).toBe(true)
    // The account the verification reported, which is the same value a
    // submitted credential would put here. Asserted as a non-empty string
    // rather than against a literal: the name comes from IAM, and pinning it
    // would only pin the stub.
    expect(hint?.value).toSatisfy(
      (value: unknown) => typeof value === 'string' && value.length > 0,
    )

    vi.unstubAllGlobals()
  })

  it('does not claim a credential the login failed to store', async () => {
    // A failed login stores nothing, so copying the success path's status would
    // claim credentials that are not there.
    //
    // Asserted against what this login wrote, not against the recorded ops as a
    // whole: the reconciler runs at mount and records `credentialsStored` from
    // whatever the store already holds, which is a different fact from what
    // this login produced.
    const { projected } = stubContract()
    mount()
    await post('/api/aishell/credentials/login/start')
    const before = mutateCalls.length
    await deliver(projected.address, { access: 'AK' })
    await settle()

    const written = mutateCalls.slice(before).flat()
    expect(written.some(op => op.path[0] === 'credentialsStored')).toBe(false)
    expect(written.some(op => op.path[0] === 'accessKeyIdHint')).toBe(false)
    // The failure itself is still recorded, so the card can say what happened.
    expect(written.some(op => op.path[0] === 'loginOutcome')).toBe(true)

    vi.unstubAllGlobals()
  })
})

describe('the probe and the login are separate operations', () => {
  it('releases the probe port without starting a login', async () => {
    // The bug: probing bound a port and armed the login deadline, so a card
    // read and abandoned expired on its own after ten minutes and reported a
    // failed sign-in nobody had started. The probe must borrow a port, be
    // answered, and give it straight back.
    stubContract()
    mount()

    const answer = await (await post('/api/aishell/credentials/login/probe')).json() as {
      ok: boolean
      probeUrl: string
    }
    expect(answer.ok).toBe(true)

    const target = new URL(answer.probeUrl)
    // Reachable while the probe is up…
    await expect(realFetch(answer.probeUrl, { method: 'GET' })).resolves.toBeDefined()

    // …and gone once it has been answered, without any login having begun.
    await expect(realFetch(`http://${target.host}/`, { method: 'GET' })).rejects.toBeDefined()

    // Nothing was recorded about a login, because none started.
    const ops = mutateCalls.flat()
    expect(ops.some(op => op.path[0] === 'loginOutcome')).toBe(false)

    vi.unstubAllGlobals()
  })

  it('does not report a login as in progress after only a probe', async () => {
    // A probe must not occupy the one-login-at-a-time slot, or a person who
    // opened the card and then clicked would be refused by their own probe.
    stubContract()
    mount()

    await post('/api/aishell/credentials/login/probe')
    const started = await post('/api/aishell/credentials/login/start')

    expect(started.status).toBe(200)

    vi.unstubAllGlobals()
  })
})
