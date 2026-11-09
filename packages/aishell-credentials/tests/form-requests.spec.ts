/**
 * How the plugin routes a credential-form request through to the tool.
 *
 * One property here, and it is the one that is easy to get wrong in a way
 * nobody notices: **two calls blocked on credentials share one form.**
 *
 * The earlier design superseded. A second `auth` call settled the first as
 * `cancelled`, so the first model was told the person had refused — which they
 * had not, and which made that model stop asking. Both were waiting for the
 * same person to fill the same form.
 *
 * The form itself, the routes and the settings document are stubs: what is
 * under test is the bookkeeping inside `apply()`.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'

/** Ops written through `settings.mutate`, in order. */
let mutateCalls: Array<Array<{ op: string, path: string[], value?: unknown }>> = []
/** Form-open requests the browser half would see, oldest first. */
let writtenRequests: Array<{ token: string, sessionId: string }> = []

/** A ctx covering exactly what apply() touches for this behaviour. */
function makeCtx() {
  const ctx = {
    fiber: { entry: { options: { id: 'aishell-client-credentials' } } },
    logger: () => ({ info() {}, warn() {}, error() {} }),
    settings: {
      mutate: (_ns: string, ops: Array<{ op: string, path: string[], value?: unknown }>) => {
        mutateCalls.push(ops)
        for (const op of ops) {
          if (op.path[0] === 'credentialFormRequest' && typeof op.value === 'string') {
            writtenRequests.push(JSON.parse(op.value) as { token: string, sessionId: string })
          }
        }
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
    // No tool registry: the `auth` tool is a no-op here, and its own behaviour
    // is covered in auth-tool.spec.ts.
    inject() {},
  }
  return { ctx }
}

/** A Config-shaped object with every field apply() reads. */
const config = {
  credentialsStored: { get: () => false },
  accessKeyIdHint: { get: () => '' },
  lastError: { get: () => '' },
  credentialFormRequest: { get: () => '' },
  loginOutcome: { get: () => '' },
}

/** The `requestForm` dependency apply() hands the tool. */
let requestForm: ((sessionId: string) => Promise<unknown> | undefined) | undefined

vi.mock('../src/auth-tool.ts', () => ({
  AUTH_TOOL_NAME: 'aishell__auth',
  registerAuthTool: (_ctx: unknown, _store: unknown, deps: { requestForm: typeof requestForm }) => {
    requestForm = deps.requestForm
  },
}))

const { apply } = await import('../src/index.ts')

beforeEach(() => {
  mutateCalls = []
  writtenRequests = []
  routes = new Map()
  requestForm = undefined
})

/** Mount the plugin and return the captured `requestForm`. */
function mount(): (sessionId: string) => Promise<unknown> | undefined {
  const { ctx } = makeCtx()
  apply(ctx as never, config as never)
  if (requestForm === undefined) throw new Error('the auth tool was not registered')
  return requestForm
}

/** Routes registered through the stubbed connection, by path. */
let routes: Map<string, (request: Request) => Promise<Response>>

/** POST one JSON body to a registered route. */
function post(path: string, body: unknown): Promise<Response> {
  const handler = routes.get(path)
  if (handler === undefined) throw new Error(`no route registered at ${path}`)
  return handler(new Request(`http://x${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }))
}

describe('credential form requests — one form for concurrent callers', () => {
  it('opens a form and writes its request to the settings document', () => {
    const open = mount()

    void open('session-1')

    expect(writtenRequests).toHaveLength(1)
    expect(writtenRequests[0]?.sessionId).toBe('session-1')
    expect(typeof writtenRequests[0]?.token).toBe('string')
  })

  it('returns the same pending outcome to a second caller', () => {
    // Both are waiting for the same person to fill the same form. A second
    // request would put two forms in front of them and settle the wrong one.
    const open = mount()

    const first = open('session-1')
    const second = open('session-1')

    expect(second).toBe(first)
    expect(writtenRequests).toHaveLength(1)
  })

  it('does not settle the first caller when a second arrives', async () => {
    // A second request must not settle the first as `cancelled`: that would tell
    // the earlier model the user had refused, which is a different answer from
    // "superseded" and one they cannot act on.
    const open = mount()

    const first = open('session-1')
    open('session-1')

    let settled = false
    void (first as Promise<unknown>).then(() => { settled = true })
    await new Promise(resolve => setTimeout(resolve, 10))

    expect(settled).toBe(false)
  })

  it('keeps sharing while the form is still unanswered', async () => {
    // Sharing is per open form, not for the lifetime of the plugin. While the
    // person has not answered, a later caller joins the same form.
    const open = mount()

    const first = open('session-1')
    const second = open('session-1')
    const third = open('session-1')

    expect(second).toBe(first)
    expect(third).toBe(first)
    // One form was put on screen, not three.
    expect(writtenRequests).toHaveLength(1)
  })

  it('returns undefined when there is no settings namespace to write to', () => {
    // No Loader row: no document, no browser half, no form. The tool then fails
    // rather than waiting for an answer that cannot come.
    const ctx = makeCtx().ctx as { fiber: { entry?: unknown } }
    ctx.fiber.entry = undefined
    apply(ctx as never, config as never)
    const open = requestForm

    expect(open?.('session-1')).toBeUndefined()
  })
})
describe('credential form requests — releasing the shared form', () => {
  it('starts a fresh form after the person cancels', async () => {
    // Sharing is bounded by one form. If an answered request were left in
    // place, every later call would be handed its already-settled promise and
    // return "cancelled" without ever asking.
    const open = mount()
    const first = open('session-1')
    const token = writtenRequests[0]?.token ?? ''

    await post('/api/aishell/credentials/cancel', { token })
    await expect(first).resolves.toEqual({ kind: 'cancelled' })

    const second = open('session-1')
    expect(second).not.toBe(first)
    expect(writtenRequests).toHaveLength(2)
  })

  it('ignores a cancel whose token names a superseded form', async () => {
    // The browser can deliver a cancel for a form that has since been
    // replaced. Settling the current one would end a call the person is
    // still looking at.
    const open = mount()
    const first = open('session-1')

    await post('/api/aishell/credentials/cancel', { token: 'not-this-one' })

    let settled = false
    void (first as Promise<unknown>).then(() => { settled = true })
    await new Promise(resolve => setTimeout(resolve, 10))
    expect(settled).toBe(false)
  })

  it('rejects a cancel with no token', async () => {
    mount()
    const response = await post('/api/aishell/credentials/cancel', {})
    expect(response.status).toBe(400)
  })
})

describe('credential form requests — confirming credentials already stored', () => {
  it('settles a waiting call as submitted, without touching the store', async () => {
    // The signed-in card's affirmative action. A person who was already
    // authenticated has no credential to post, so the save route — the only
    // other thing that settles a request — can never answer their blocked
    // call. Confirm is what does, and it must read as "done", not "declined".
    const open = mount()
    const waiting = open('session-1')
    const token = writtenRequests[0]?.token ?? ''

    const response = await post('/api/aishell/credentials/confirm', { token })

    expect(response.status).toBe(200)
    await expect(waiting).resolves.toEqual({ kind: 'submitted' })
  })

  it('takes the form out of the document, so a later call gets a fresh one', async () => {
    // The request field is persisted. A confirm that settled the promise
    // without clearing the document would leave a request the browser reopens
    // on the next boot, and every later call would join a settled promise.
    const open = mount()
    const first = open('session-1')
    await post('/api/aishell/credentials/confirm', { token: writtenRequests[0]?.token ?? '' })

    const second = open('session-1')
    expect(second).not.toBe(first)
    expect(writtenRequests).toHaveLength(2)
  })

  it('ignores a confirm whose token names a superseded form', async () => {
    // Same reasoning as the cancel route: the browser can deliver an answer
    // for a form that has since been replaced, and settling the current one
    // would end a call the person is still looking at.
    const open = mount()
    const waiting = open('session-1')

    await post('/api/aishell/credentials/confirm', { token: 'not-this-one' })

    let settled = false
    void (waiting as Promise<unknown>).then(() => { settled = true })
    await new Promise(resolve => setTimeout(resolve, 10))
    expect(settled).toBe(false)
  })

  it('rejects a confirm with no token', async () => {
    mount()
    const response = await post('/api/aishell/credentials/confirm', {})
    expect(response.status).toBe(400)
  })
})
describe('a request left over from a previous process', () => {
  /** Mount with a request already sitting in the document, as a restart leaves it. */
  function mountWithStaleRequest(): void {
    const { ctx } = makeCtx()
    const stale = JSON.stringify({ token: 'from-last-run', sessionId: 'session-old' })
    const withStale = {
      ...config,
      credentialFormRequest: { get: () => stale },
    }
    apply(ctx as never, withStale as never)
  }

  it('is cleared from the document at startup', () => {
    // The bug: the field is persisted, so a request written by a previous
    // process survived into the next one. Nothing could be waiting on it — the
    // call that asked ended with the process — but the browser half read it on
    // its first pass and opened the credential form, so every install showed a
    // form nobody had asked for.
    mountWithStaleRequest()

    const cleared = mutateCalls.flat().some(
      op => op.path[0] === 'credentialFormRequest' && op.op === 'unset',
    )
    expect(cleared).toBe(true)
  })

  it('does not write when the document holds no request', () => {
    // An ordinary boot has nothing to clear, and a mutation per start would be
    // a document write for no change.
    mount()

    const touched = mutateCalls.flat().some(op => op.path[0] === 'credentialFormRequest')
    expect(touched).toBe(false)
  })
})
