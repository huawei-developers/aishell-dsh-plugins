/**
 * The gateway connection: how the SDK is configured, when a handle is reused,
 * and when the key is refreshed.
 *
 * `e2b` is stubbed here rather than exercised, because what is under test is
 * how this plugin drives it — which options it passes, which instance it keeps
 * for a given sandbox, and under exactly which failure it decides the key is
 * the problem. The SDK's own behaviour against the gateway is covered by the
 * gateway's acceptance suite, not here.
 *
 * The decisions worth pinning:
 *
 *   - **The SDK is configured with the domain alone.** No patched transport, no
 *     URL rewriting: that a stock client reaches the gateway with two settings
 *     is the property the gateway exists to provide, and a workaround here
 *     would hide it breaking.
 *   - **One handle per sandbox.** Rebuilding one per call would discard the
 *     per-sandbox tokens the create response carried.
 *   - **Only an authentication failure refreshes the key**, and only once. A
 *     refresh rotates the tenant, so triggering it on an unrelated failure
 *     would silently orphan the sandbox.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'

/** Options every `Sandbox.create` / `Sandbox.connect` call received. */
let createCalls: Array<{ template: string | undefined, opts: Record<string, unknown> }> = []
/** Options every `Sandbox.list` call received. */
let listCalls: Array<Record<string, unknown>> = []
/** Sandboxes the stub hands back, keyed by id. */
let sandboxes: Map<string, StubSandbox> = new Map()
/** Ids `Sandbox.connect` should fail on, with the error to throw. */
let connectFailures: Map<string, Error> = new Map()
/** How many times `Sandbox.connect` was entered, per id. */
let connectAttempts: Map<string, number> = new Map()
/** Whether a queued connect failure outlasts the key replacement. */
let failurePersists = false
/** Rows a metadata-filtered list reports, when a spec queues any. */
let metadataFiltered: Array<{ sandboxId: string, state: string }> = []
/** Page sizes the list stub serves; one entry per page, in order. */
let pageSizes: number[] = []
/** Page indices the list stub was asked for, in order. */
let listPages: number[] = []

/** The shape this plugin uses of an SDK sandbox. */
interface StubSandbox {
  sandboxId: string
  getInfo: () => Promise<unknown>
  kill: () => Promise<void>
  getHost: (port: number) => string
}

/** Build the SDK stub and register it for the module under test. */
function makeStubSandbox(id: string): StubSandbox {
  return {
    sandboxId: id,
    getInfo: async () => ({
      sandboxId: id,
      templateId: 'base',
      state: 'running',
      startedAt: new Date('2026-01-01T00:00:00Z'),
      endAt: new Date('2026-01-01T00:05:00Z'),
      cpuCount: 2,
      memoryMB: 512,
      envdVersion: '0.6.10',
      metadata: {},
    }),
    kill: async () => {},
    getHost: (port: number) => `${port}-${id}.example.test`,
  }
}

vi.mock('e2b', () => ({
  Sandbox: {
    create: async (a: unknown, b?: unknown) => {
      const template = typeof a === 'string' ? a : undefined
      const opts = (typeof a === 'string' ? b : a) as Record<string, unknown>
      createCalls.push({ template, opts })
      const id = `sbx-${createCalls.length}`
      const sandbox = makeStubSandbox(id)
      sandboxes.set(id, sandbox)
      return sandbox
    },
    connect: async (id: string, opts: Record<string, unknown>) => {
      createCalls.push({ template: undefined, opts: { ...opts, connect: id } })
      const attempt = (connectAttempts.get(id) ?? 0) + 1
      connectAttempts.set(id, attempt)
      // A failure models the gateway refusing a key. Unless a spec asks for
      // it to outlast the replacement, it holds only for the attempt that
      // presented the refused key — a retry with a different key succeeds.
      const failure = (attempt === 1 || failurePersists) ? connectFailures.get(id) : undefined
      if (failure !== undefined) throw failure
      const existing = sandboxes.get(id)
      if (existing !== undefined) return existing
      const sandbox = makeStubSandbox(id)
      sandboxes.set(id, sandbox)
      return sandbox
    },
    /**
   * Sandboxes a list reports. The stub models the gateway: it answers whatever
   * was queued, so a spec can present a paused sandbox or several candidates
   * without needing a real backend. With nothing queued it reports the created
   * sandboxes, which is what an unfiltered list would see.
   */
  list: (opts: Record<string, unknown>) => {
      listCalls.push(opts)
      const created = [...sandboxes.values()].map(sandbox => ({
        sandboxId: sandbox.sandboxId,
        state: 'running',
      }))
      const rows = metadataFiltered.length > 0 ? metadataFiltered : created
      const project = (row: { sandboxId: string, state: string }) => ({
        sandboxId: row.sandboxId,
        templateId: 'base',
        state: row.state,
        startedAt: new Date('2026-01-01T00:00:00Z'),
        endAt: new Date('2026-01-01T00:05:00Z'),
      })
      // Models the real paginator: pages come from `pageSizes`, and `hasNext`
      // is driven the way the SDK drives it — from the cursor the response
      // carried, not from the caller's guess.
      let page = 0
      let hasNext = true
      const paginator = {
        get hasNext() { return hasNext },
        nextItems: async () => {
          listPages.push(page)
          const size = pageSizes[page] ?? rows.length
          const start = pageSizes.slice(0, page).reduce((a, b) => a + b, 0)
          const slice = rows.slice(start, start + size)
          page += 1
          hasNext = page < pageSizes.length
          return slice.map(project)
        },
      }
      return paginator
    },
  },
}))

const { MemoryBackend } = await import('@huaweidevtools/aishell-dsh-credentials-store')
const { SandboxClient, DEFAULT_TEMPLATE } = await import('../src/client.ts')
const { SandboxKeySource } = await import('../src/sandbox-key.ts')
type KeySource = InstanceType<typeof SandboxKeySource>

/** Keys the stub key source returns, in order. */
let keys: string[]
/** Fetches the key source performed. */
let keyFetches: number

beforeEach(() => {
  createCalls = []
  listCalls = []
  sandboxes = new Map()
  connectFailures = new Map()
  connectAttempts = new Map()
  failurePersists = false
  metadataFiltered = []
  pageSizes = []
  listPages = []
  keys = ['sk-e2b-1']
  keyFetches = 0
})

/** A key source that hands out `keys` in order without any network. */
function makeKeys(): KeySource {
  const source = new SandboxKeySource({
    baseUrl: 'https://openapi.example.test',
    readCredentials: () => ({ ak: 'AK1', sk: 'SK1' }),
    store: new MemoryBackend(),
    fetchImpl: async () => {
      const key = keys[keyFetches] ?? keys[keys.length - 1] ?? ''
      keyFetches += 1
      return Response.json({ api_key: key }, { status: 201 })
    },
    timeoutMs: 5_000,
  })
  return source
}

function makeClient(keys2 = makeKeys()): InstanceType<typeof SandboxClient> {
  return new SandboxClient({
    resolveDomain: () => 'aishell.example.test',
    keys: keys2,
    resolveRequestTimeoutMs: () => 30_000,
  })
}

describe('SandboxClient — the SDK configuration', () => {
  it('passes the domain and the key, and nothing else it was not asked for', async () => {
    const client = makeClient()

    await client.create(undefined, {})

    const opts = createCalls[0]?.opts
    // The whole configuration a stock E2B client needs for this gateway.
    expect(opts?.domain).toBe('aishell.example.test')
    expect(opts?.apiKey).toBe('sk-e2b-1')
    expect(opts?.requestTimeoutMs).toBe(30_000)
    // Nothing was invented: no patched transport, no rewritten URL.
    expect(opts).not.toHaveProperty('apiUrl')
    expect(opts).not.toHaveProperty('sandboxUrl')
    expect(opts).not.toHaveProperty('proxy')
  })

  it('names a template even when the caller named none', async () => {
    // Not optional: an omitted template lets the SDK fall back to `"base"`,
    // which this gateway answers with `404 sandbox unknown was not found`.
    // Forwarding `undefined` is what made create unusable against the real
    // service while every unit test passed.
    const client = makeClient()

    await client.create(undefined, {})
    await client.create('node', {})

    expect(createCalls[0]?.template).toBe(DEFAULT_TEMPLATE)
    expect(createCalls[0]?.template).toBe('default')
    expect(createCalls[1]?.template).toBe('node')
  })

  it('forwards create options and omits the ones left out', async () => {
    const client = makeClient()

    await client.create(undefined, {
      timeoutMs: 300_000,
      envs: { A: '1' },
      metadata: { client: 'test' },
    })

    const opts = createCalls[0]?.opts
    expect(opts?.timeoutMs).toBe(300_000)
    expect(opts?.envs).toEqual({ A: '1' })
    expect(opts?.metadata).toEqual({ client: 'test' })
  })
})

describe('SandboxClient — handles', () => {
  it('reuses one handle per sandbox across calls', async () => {
    const client = makeClient()
    const created = await client.create(undefined, {})

    const first = await client.handle(created.sandboxId)
    const second = await client.handle(created.sandboxId)

    // Same object: rebuilding it would re-resolve endpoints and drop the
    // tokens the create response carried.
    expect(first).toBe(second)
    expect(first).toBe(created)
  })

  it('re-resolves after a handle is forgotten', async () => {
    const client = makeClient()
    const created = await client.create(undefined, {})
    client.forget(created.sandboxId)

    const resolved = await client.handle(created.sandboxId)

    expect(resolved.sandboxId).toBe(created.sandboxId)
    // One create, then one connect — the forget forced the second resolution.
    expect(createCalls).toHaveLength(2)
    expect(createCalls[1]?.opts.connect).toBe(created.sandboxId)
  })

  it('never fetches a second key while one works', async () => {
    const client = makeClient()

    await client.create(undefined, {})
    await client.create(undefined, {})

    expect(keyFetches).toBe(1)
  })
})

describe('SandboxClient — key refresh', () => {
  it('refreshes once when the gateway rejects the key', async () => {
    keys = ['sk-e2b-1', 'sk-e2b-2']
    const client = makeClient()
    connectFailures.set('sbx-9', authenticationError())

    const handle = await client.handle('sbx-9')

    expect(handle.sandboxId).toBe('sbx-9')
    expect(keyFetches).toBe(2)
    // The retry presented the new key rather than repeating the old one.
    expect(createCalls[1]?.opts.apiKey).toBe('sk-e2b-2')
  })

  it('does not refresh for a failure that says nothing about the key', async () => {
    const client = makeClient()
    connectFailures.set('sbx-9', notFoundError())

    await expect(client.handle('sbx-9')).rejects.toThrow()

    // One fetch for the whole attempt: a sandbox that is gone is not evidence
    // about the credential, and rotating the tenant would orphan others.
    expect(keyFetches).toBe(1)
  })

  it('discards the stored key on an authentication failure and retries with the new one', async () => {
    keys = ['sk-e2b-1', 'sk-e2b-2']
    const client = makeClient()
    connectFailures.set('sbx-9', authenticationError())

    const handle = await client.handle('sbx-9')

    // Two creates: the first key was refused, so it was discarded from the
    // store and a new one issued. That is the whole recovery path.
    expect(keyFetches).toBe(2)
    expect(handle.sandboxId).toBe('sbx-9')
    // The retry presented the new key rather than replaying the refused one.
    const retry = createCalls.filter(call => call.opts.apiKey === 'sk-e2b-2')
    expect(retry.length).toBeGreaterThan(0)
  })

  it('does not retry twice when the replacement key is also refused', async () => {
    keys = ['sk-e2b-1', 'sk-e2b-2']
    failurePersists = true
    const client = makeClient()
    connectFailures.set('sbx-9', authenticationError())

    // The recovery is bounded: one replacement, then the failure is reported
    // rather than looping on a service that refuses everything.
    await expect(client.handle('sbx-9')).rejects.toThrow(/unauthorized/)
    expect(keyFetches).toBe(2)
  })
})

describe('SandboxClient — list', () => {
  it('projects listed sandboxes into the shape the tool renders', async () => {
    const client = makeClient()
    await client.create(undefined, {})

    const rows = await client.list(undefined)

    expect(listCalls).toHaveLength(1)
    expect(listCalls[0]?.domain).toBe('aishell.example.test')
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      sandboxId: 'sbx-1',
      state: 'running',
      startedAt: '2026-01-01T00:00:00.000Z',
      endAt: '2026-01-01T00:05:00.000Z',
    })
  })

  it('sends no metadata filter for an unfiltered list', async () => {
    const client = makeClient()

    await client.list(undefined)

    // `list` answers "what does this account have", so it filters nothing.
    expect(listCalls[0]).not.toHaveProperty('query')
  })

  it('reports every page, not just the first', async () => {
    metadataFiltered = [
      { sandboxId: 'sbx-a', state: 'running' },
      { sandboxId: 'sbx-b', state: 'running' },
      { sandboxId: 'sbx-c', state: 'running' },
    ]
    pageSizes = [2, 1]
    const client = makeClient()

    const rows = await client.list(undefined)

    // "These are all of them" must not mean "the first hundred".
    expect(listPages).toEqual([0, 1])
    expect(rows.map(row => row.sandboxId)).toEqual(['sbx-a', 'sbx-b', 'sbx-c'])
  })
})

describe('SandboxClient — findByMetadata', () => {
  it('filters by the metadata pair and passes state through untouched', async () => {
    metadataFiltered = [{ sandboxId: 'sbx-7', state: 'paused' }]
    const client = makeClient()

    const rows = await client.findByMetadata({ 'aishell-session': 's1' }, undefined)

    // The pair rides the SDK's `query.metadata`, which the gateway forwards to
    // the upstream unchanged — that is the whole recovery mechanism.
    expect(listCalls[0]).toMatchObject({
      query: { metadata: { 'aishell-session': 's1' } },
    })
    // State is reported as the gateway reported it. Deciding which states are
    // usable is the registry's job, not this projection's.
    expect(rows).toEqual([{ sandboxId: 'sbx-7', state: 'paused' }])
  })

  it('reports an empty result rather than throwing', async () => {
    const client = makeClient()

    expect(await client.findByMetadata({ 'aishell-session': 's1' }, undefined)).toEqual([])
  })

  it('follows the cursor instead of stopping at the first page', async () => {
    // The gateway pages at 100, and a conversation's sandbox is not ordered
    // ahead of the rest — so a single-page search would report "none" on the
    // day an account holds more than one page.
    metadataFiltered = [
      { sandboxId: 'sbx-a', state: 'paused' },
      { sandboxId: 'sbx-b', state: 'running' },
      { sandboxId: 'sbx-c', state: 'paused' },
    ]
    pageSizes = [2, 1]
    const client = makeClient()

    const rows = await client.findByMetadata({ 'aishell-session': 's1' }, undefined)

    expect(listPages).toEqual([0, 1])
    expect(rows.map(row => row.sandboxId)).toEqual(['sbx-a', 'sbx-b', 'sbx-c'])
  })

  it('stops when the cursor stops', async () => {
    metadataFiltered = [{ sandboxId: 'sbx-a', state: 'running' }]
    pageSizes = [1]
    const client = makeClient()

    await client.findByMetadata({ 'aishell-session': 's1' }, undefined)

    // One request: the response carried no cursor, so there was no next page.
    expect(listPages).toEqual([0])
  })
})

/** An error shaped like the SDK's `AuthenticationError`. */
function authenticationError(): Error {
  const error = new Error('unauthorized')
  Object.defineProperty(error, 'constructor', { value: { name: 'AuthenticationError' } })
  return error
}

/** An error shaped like the SDK's `SandboxNotFoundError`. */
function notFoundError(): Error {
  const error = new Error('sandbox not found')
  Object.defineProperty(error, 'constructor', { value: { name: 'SandboxNotFoundError' } })
  return error
}