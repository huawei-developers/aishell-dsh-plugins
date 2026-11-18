import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import { LlmError, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { CredentialsStore } from '@huaweidevtools/aishell-dsh-credentials-store'

// In-memory keyring, injected below.
//
// This MUST go through `__setKeyringModule`, not `vi.mock('@napi-rs/keyring')`.
// KeyringBackend loads the native module with `createRequire(import.meta.url)`,
// which vi.mock cannot intercept — a mocked module name is simply ignored and
// the real keyring is used, so the fixtures below would be written into the
// developer's actual OS keyring and destroy their stored credentials. That is
// not hypothetical: it happened.
const { keyringStore } = vi.hoisted(() => ({ keyringStore: new Map<string, string>() }))

class MockEntry {
  constructor(private readonly service: string, private readonly account: string) {}
  private key(): string { return `${this.service}:${this.account}` }
  setPassword(value: string): void { keyringStore.set(this.key(), value) }
  getPassword(): string | null { return keyringStore.get(this.key()) ?? null }
  deletePassword(): void { keyringStore.delete(this.key()) }
}

// Mock fetch
const fetchMock = vi.fn()
vi.stubGlobal('fetch', fetchMock)

const { createCredentialsStore, __setKeyringModule, __clearKeyringRefusal } = await import('@huaweidevtools/aishell-dsh-credentials-store')
const { GatewayAdapter } = await import('../src/adapter.ts')

/** The adapter's instance type; the destructured class is a value, not a type. */
type GatewayAdapter = InstanceType<typeof GatewayAdapter>

// Inject before any KeyringBackend is constructed.
__setKeyringModule({ Entry: MockEntry })

// `vitest.setup.ts` runs first and seals the real keyring with an `Entry` that
// throws, which latches the process-wide refusal before this file's mock is
// installed. Clearing it here is what makes this spec's own in-memory keyring
// reachable — the same reset every spec that installs its own backend needs.
__clearKeyringRefusal()

const BASE_URL = 'https://test.example.com/v2'

/** The plugin's own image-budget defaults; fixtures use them unless a test overrides. */
const IMAGE_BUDGET = { maxPixels: 4_194_304, maxBytes: 1_048_576 }
const MAX_REQUEST_IMAGE_BYTES = 20_971_520

function makeAdapter(opts?: {
  noCredentials?: boolean
  resolveAttachments?: () => unknown
  maxRequestImageBytes?: number
  baseUrl?: () => string
  /** A store this test owns, so it can rotate the account mid-test. */
  keyring?: CredentialsStore
  /** Observe catalog-change notifications. */
  onCatalogChanged?: () => void
  /** Observe the adapter's reports about unusable catalog entries. */
  warn?: (message: string) => void
}): GatewayAdapter {
  const keyring = opts?.keyring ?? createCredentialsStore()
  if (!opts?.noCredentials && opts?.keyring === undefined) {
    keyring.set('HW_ACCESS_KEY', 'test-ak')
    keyring.set('HW_SECRET_KEY', 'test-sk')
  }
  return new GatewayAdapter({
    resolveBaseUrl: opts?.baseUrl ?? (() => BASE_URL),
    keyring,
    resolveImageBudget: () => IMAGE_BUDGET,
    resolveMaxRequestImageBytes: () => opts?.maxRequestImageBytes ?? MAX_REQUEST_IMAGE_BYTES,
    ...(opts?.resolveAttachments === undefined
      ? {}
      : { resolveAttachments: opts.resolveAttachments as never }),
    ...(opts?.onCatalogChanged === undefined ? {} : { onCatalogChanged: opts.onCatalogChanged }),
    ...(opts?.warn === undefined ? {} : { warn: opts.warn }),
  })
}

/** An in-memory store a test can write to, with no machine state behind it. */
function ownStore(credentials: Record<string, string> = {}): CredentialsStore {
  const entries = new Map(Object.entries(credentials))
  return {
    get: (account: string) => entries.get(account),
    has: (account: string) => entries.has(account),
    set: (account: string, value: string) => { entries.set(account, value) },
    delete: (account: string) => { entries.delete(account) },
  }
}

/** Build a fake SSE ReadableStream from data payloads. */
function sseStream(payloads: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder()
  const chunks = payloads.map(p => `data: ${p}\n\n`).join('')
  return new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(chunks))
      controller.close()
    },
  })
}

// Built through the framework's own constructor rather than a bare literal.
// Message ids are branded (`MessageId`) and a user message's source kind is
// `user`, so `{ id: 'm1', role: 'user', source: { kind: 'human' } }` is not a
// Message — and `noUncheckedIndexedAccess` plus the brand make that a compile
// error rather than something to discover at runtime.
const baseOptions: GenerateOptions = {
  provider: 'aishell',
  model: 'glm-5.2',
  messages: [
    createUserMessage({
      source: { kind: 'user' },
      content: [{ type: 'text', text: 'hello' }],
    }),
  ],
}

describe('GatewayAdapter — providerInfo / resolveModel', () => {
  it('providerInfo returns AI Shell', () => {
    const adapter = makeAdapter()
    expect(adapter.providerInfo('aishell')).toEqual({ id: 'aishell', name: 'AI Shell' })
  })

  it('resolveModel returns identity-only when /models fails', async () => {
    fetchMock.mockRejectedValueOnce(new Error('network'))
    const adapter = makeAdapter()
    const info = await adapter.resolveModel('aishell', 'unknown-model')
    expect(info).toEqual({
      provider: 'aishell',
      id: 'unknown-model',
      name: 'unknown-model',
    })
  })

  it('resolveModel passes context window + reasoning from /models, and derives the output cap', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        data: [{
          id: 'glm-5.3-flash',
          modalities: ['text', 'image'],
          reasoning_effort: ['low', 'medium', 'high'],
          // The gateway's own completion cap, which is preferred over the
          // window share and here is well inside what the window allows.
          limits: { context_window: 1048576, max_completion_tokens: 131072 },
        }],
      }),
    })
    const adapter = makeAdapter()
    const info = await adapter.resolveModel('aishell', 'glm-5.3-flash')
    expect(info.id).toBe('glm-5.3-flash')
    expect(info.inputModalities).toEqual(['text', 'image'])
    expect(info.context).toEqual({ contextWindow: 1048576 })
    // The advertised 131072, not the 10% share — and it is compactable.
    expect(info.defaultMaxTokens).toBe(131072)
    expect(info.reasoning?.efforts).toHaveLength(3)
    expect(info.reasoning?.efforts[0]).toEqual({ id: 'low', name: 'low' })
  })
})

describe('GatewayAdapter — listModels', () => {
  beforeEach(() => {
    keyringStore.clear()
    fetchMock.mockReset()
  })

  it('GETs /models with AK/SK signing, passes modalities', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        data: [
          { id: 'glm-5.3-flash', modalities: ['text', 'image'], limits: { context_window: 1048576 } },
          { id: 'glm-5.2', modalities: ['text'], limits: { context_window: 131072 } },
        ],
      }),
    })
    const adapter = makeAdapter()
    const models = await adapter.listModels('aishell')
    expect(models).toHaveLength(2)
    expect(models[0]).toEqual({ provider: 'aishell', id: 'glm-5.3-flash', name: 'glm-5.3-flash', inputModalities: ['text', 'image'] })
    expect(models[1]).toEqual({ provider: 'aishell', id: 'glm-5.2', name: 'glm-5.2', inputModalities: ['text'] })

    expect(fetchMock).toHaveBeenCalledOnce()
    const [url, init] = fetchMock.mock.calls[0]!
    expect(String(url)).toBe(`${BASE_URL}/models`)
    expect(init.method).toBe('GET')
    // Authorization must be SDK-HMAC-SHA256, not Bearer
    expect(init.headers.Authorization).toMatch(/^SDK-HMAC-SHA256 /)
  })

  it('prefers the wire name over the id, and falls back to the id without one', async () => {
    // The gateway may label a model (`name`) independently of its routing id.
    // The reserved alias is the case that motivates it: `trial` is a durable
    // id, not a pleasant label, so the picker must show the wire name when
    // there is one. Both branches are asserted because the fallback is what
    // every current catalog entry relies on — the gateway sends no `name`
    // today, and dropping it would silently blank the picker.
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        data: [
          { id: 'trial', name: 'AI Shell 体验', limits: { context_window: 1048576 } },
          { id: 'glm-5.2', limits: { context_window: 131072 } },
        ],
      }),
    })
    const adapter = makeAdapter()
    const models = await adapter.listModels('aishell')
    expect(models[0]).toEqual({ provider: 'aishell', id: 'trial', name: 'AI Shell 体验' })
    expect(models[1]).toEqual({ provider: 'aishell', id: 'glm-5.2', name: 'glm-5.2' })
  })

  it('resolves a labelled model to its wire name, and an unknown one to its id', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ data: [{ id: 'trial', name: 'AI Shell 体验', limits: { context_window: 1048576 } }] }),
    })
    const adapter = makeAdapter()
    const labelled = await adapter.resolveModel('aishell', 'trial')
    expect(labelled).toEqual({
      // No declared cap here, so the 10% share applies.
      provider: 'aishell', id: 'trial', name: 'AI Shell 体验',
      context: { contextWindow: 1048576 }, defaultMaxTokens: 104857,
    })

    // A model the catalog does not carry has no wire name to read; the id
    // stands in until the request itself is rejected with AISHELL.1004.
    const absent = await adapter.resolveModel('aishell', 'glm-9.9')
    expect(absent).toEqual({ provider: 'aishell', id: 'glm-9.9', name: 'glm-9.9' })
  })

  it('signs the full request path, including any segment the base URL carries', async () => {
    // The signature covers the canonical URI, so signing the relative path
    // while requesting `base + path` produces a request the gateway rejects.
    // BASE_URL carries `/v2` precisely so this is exercised; the default
    // baseUrl carries `/v1` for the same reason.
    //
    // Time is frozen because the signed timestamp has second granularity: two
    // signings in different seconds produce different signatures for identical
    // input, so without this the comparison would pass or fail by luck.
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-10-13T00:00:00Z'))
    try {
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ data: [{ id: 'glm-5.3-flash', modalities: ['text'], limits: { context_window: 1048576 } }] }),
      })
      await makeAdapter().listModels('aishell')
      const [url, init] = fetchMock.mock.calls[0]!
      const requestUrl = new URL(String(url))
      expect(requestUrl.pathname).toBe('/v2/models')

      // Recompute from the request's own URL: byte-identical only when the
      // signer saw the same method, host, path and body.
      const { sign } = await import('@huaweidevtools/aishell-dsh-credentials-store/signer')
      const expected = sign('GET', requestUrl.host, requestUrl.pathname, {}, '', { ak: 'test-ak', sk: 'test-sk' })
      expect(init.headers.Authorization).toBe(expected.Authorization)
    } finally {
      vi.useRealTimers()
    }
  })

  it('returns empty array on fetch error', async () => {
    fetchMock.mockRejectedValueOnce(new Error('network'))
    const adapter = makeAdapter()
    const models = await adapter.listModels('aishell')
    expect(models).toEqual([])
  })

  it('returns empty array on non-ok response', async () => {
    fetchMock.mockResolvedValueOnce({ ok: false, status: 403 })
    const adapter = makeAdapter()
    const models = await adapter.listModels('aishell')
    expect(models).toEqual([])
  })
})

describe('GatewayAdapter — catalog cache', () => {
  beforeEach(() => {
    keyringStore.clear()
    fetchMock.mockReset()
    // A fixed clock for the whole block, so "the catalog went stale" is one
    // explicit step rather than a sleep. Only `Date` is faked: the listing
    // deadline is `AbortSignal.timeout`, which runs on a native timer a faked
    // `setTimeout` cannot drive — faking that too would leave every request
    // waiting on the test's own real deadline.
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(1_000_000)
  })

  afterEach(() => { vi.useRealTimers() })

  /** One catalog answer, optionally a failure. */
  const answering = (data: unknown[]): { ok: true, json: () => Promise<unknown> } => ({
    ok: true,
    json: async () => ({ data }),
  })

  /** Move the clock past the catalog TTL. Monotonic: each call advances again. */
  const agePastTtl = (): void => { vi.setSystemTime(Date.now() + 61_000) }

  /**
   * Let a background refresh finish.
   *
   * It runs on promises rather than on the clock, so a test that ages the clock
   * again straight after starting one would find the previous load still in
   * flight and be given the catalog it already has.
   */
  const settle = (): Promise<void> => new Promise((resolve) => { setImmediate(resolve) })

  const adapterWith = (current: () => string = () => 'test-ak'): GatewayAdapter => {
    const gateway = makeAdapter()
    // The adapter signs with whatever the store holds at call time, so a
    // rotation is a store write rather than a new adapter.
    Object.defineProperty(gateway, 'readCredentials', {
      value: () => ({ ak: current(), sk: 'test-sk' }),
    })
    return gateway
  }

  it('signs one request for repeated reads inside the TTL', async () => {
    // `listModels` and `resolveModel` both read the catalog, and a picker does
    // both per open. Signing each one would put a network round trip behind
    // opening a dropdown.
    fetchMock.mockResolvedValue(answering([{ id: 'glm-5.2', limits: { context_window: 1000 } }]))
    const adapter = makeAdapter()
    await adapter.listModels('aishell')
    await adapter.listModels('aishell')
    const info = await adapter.resolveModel('aishell', 'glm-5.2')
    expect(info.context).toEqual({ contextWindow: 1000 })
    expect(fetchMock).toHaveBeenCalledOnce()
  })

  it('keeps the previous catalog when a later load fails', async () => {
    fetchMock.mockResolvedValueOnce(answering([{ id: 'glm-5.2', limits: { context_window: 131072 } }]))
    const adapter = makeAdapter()
    expect(await adapter.listModels('aishell')).toHaveLength(1)

    agePastTtl()
    fetchMock.mockRejectedValueOnce(new Error('gateway down'))
    // The stale catalog answers at once; the failed refresh lands behind it.
    expect((await adapter.listModels('aishell')).map(m => m.id)).toEqual(['glm-5.2'])
    await Promise.resolve()
    expect((await adapter.listModels('aishell')).map(m => m.id)).toEqual(['glm-5.2'])
  })

  it('treats an empty listing as no answer rather than an empty catalog', async () => {
    // A rollout can answer `{data: []}` while it lands. Replacing the catalog
    // with that would empty the picker and strip every running Turn of its
    // capacities; the official adapter treats it as an error for this reason.
    fetchMock.mockResolvedValueOnce(answering([{ id: 'glm-5.2', limits: { context_window: 131072 } }]))
    const adapter = makeAdapter()
    await adapter.listModels('aishell')

    agePastTtl()
    fetchMock.mockResolvedValueOnce(answering([]))
    expect((await adapter.listModels('aishell')).map(m => m.id)).toEqual(['glm-5.2'])
    await Promise.resolve()
    expect((await adapter.listModels('aishell')).map(m => m.id)).toEqual(['glm-5.2'])
  })

  it('answers a stale read before the refresh lands', async () => {
    // The send path awaits `resolveModel`. Waiting for a refresh there would
    // put a `GET /models` in front of every message once a minute.
    fetchMock.mockResolvedValueOnce(answering([{ id: 'glm-5.2', limits: { context_window: 131072 } }]))
    const adapter = makeAdapter()
    await adapter.listModels('aishell')

    agePastTtl()
    const stalled = Promise.withResolvers<never>()
    fetchMock.mockReturnValueOnce(stalled.promise as never)
    const read = adapter.listModels('aishell')
    // Settles without the in-flight refresh ever answering.
    expect((await read).map(m => m.id)).toEqual(['glm-5.2'])
    stalled.resolve({ ok: false, status: 500 } as never)
  })

  it('drops the catalog when the credentials change hands', async () => {
    // A catalog describes one account's offering; another account's is a
    // different list, not a stale copy of this one.
    let account = 'first-ak'
    fetchMock.mockResolvedValueOnce(answering([{ id: 'glm-account-one', limits: { context_window: 131072 } }]))
    const adapter = adapterWith(() => account)
    expect((await adapter.listModels('aishell')).map(m => m.id)).toEqual(['glm-account-one'])

    account = 'second-ak'
    fetchMock.mockResolvedValueOnce(answering([{ id: 'glm-account-two', limits: { context_window: 131072 } }]))
    expect((await adapter.listModels('aishell')).map(m => m.id)).toEqual(['glm-account-two'])
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('re-fetches as soon as credentials are saved, without a TTL wait', async () => {
    // A save is the moment the catalog becomes readable at all, so recording
    // the empty answer would hide the models the user just unlocked for a
    // minute — exactly when they are opening the picker to use them.
    const store = ownStore()
    const adapter = makeAdapter({ keyring: store, noCredentials: true })
    expect(await adapter.listModels('aishell')).toEqual([])
    expect(fetchMock).not.toHaveBeenCalled()

    store.set('HW_ACCESS_KEY', 'test-ak')
    store.set('HW_SECRET_KEY', 'test-sk')
    fetchMock.mockResolvedValueOnce(answering([{ id: 'glm-5.2', limits: { context_window: 131072 } }]))
    expect((await adapter.listModels('aishell')).map(m => m.id)).toEqual(['glm-5.2'])
  })

  it('resolves a model by what it last was, after the catalog stops listing it', async () => {
    // A model leaves the catalog but a Turn is still running against it, or the
    // user is one step from switching to it. Losing its context window would
    // stop automatic compaction and have `compaction-basic` refuse the switch
    // outright (`MODEL_SWITCH_COMPACTION_FAILED`).
    fetchMock.mockResolvedValueOnce(answering([{ id: 'glm-5.2', limits: { context_window: 4096 } }]))
    const adapter = makeAdapter()
    await adapter.listModels('aishell')

    agePastTtl()
    fetchMock.mockResolvedValueOnce(answering([{ id: 'glm-6', limits: { context_window: 1048576 } }]))
    // The stale catalog answers at once; the refresh that retires `glm-5.2`
    // lands behind it, so wait for what the next read will see.
    await adapter.listModels('aishell')
    await settle()
    expect((await adapter.listModels('aishell')).map(m => m.id)).toEqual(['glm-6'])
    // It is gone from what the picker offers...
    // ...but still resolves with the capacities it was last seen with.
    expect((await adapter.resolveModel('aishell', 'glm-5.2')).context).toEqual({ contextWindow: 4096 })
  })

  it('reports a changed catalog once, and not for the first load', async () => {
    const onCatalogChanged = vi.fn()
    const gateway = makeAdapter({ onCatalogChanged })

    fetchMock.mockResolvedValueOnce(answering([{ id: 'glm-5.2', limits: { context_window: 131072 } }]))
    await gateway.listModels('aishell')
    // The caller that prompted the first load is holding what it would reload.
    expect(onCatalogChanged).not.toHaveBeenCalled()

    agePastTtl()
    fetchMock.mockResolvedValueOnce(answering([{ id: 'glm-5.2', limits: { context_window: 131072 } }]))
    await gateway.listModels('aishell')
    await settle()
    // Same catalog: a picker would be told to reload for nothing.
    expect(onCatalogChanged).not.toHaveBeenCalled()

    agePastTtl()
    fetchMock.mockResolvedValueOnce(answering([{ id: 'glm-5.2', limits: { context_window: 131072 } }, { id: 'glm-6', limits: { context_window: 1048576 } }]))
    await gateway.listModels('aishell')
    await settle()
    expect(onCatalogChanged).toHaveBeenCalledOnce()
  })

  it('asks for the declared output cap, falling back to a share of the window', async () => {
    // The gateway's own cap is the upstream's limit and is preferred; the share
    // only fills in for a listing that omits it. Neither is a compaction
    // decision — see `outputCapFor` — so this test pins the source, not a bound.
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({
        data: [
          { id: 'declared', limits: { context_window: 131_072, max_completion_tokens: 4_096 } },
          { id: 'undeclared', limits: { context_window: 131_072 } },
          { id: 'large', limits: { context_window: 1_048_576 } },
        ],
      }),
    })
    const adapter = makeAdapter()

    expect((await adapter.resolveModel('aishell', 'declared')).defaultMaxTokens).toBe(4_096)
    // Ten percent of the window.
    expect((await adapter.resolveModel('aishell', 'undeclared')).defaultMaxTokens).toBe(13_107)
    expect((await adapter.resolveModel('aishell', 'large')).defaultMaxTokens).toBe(104_857)
  })

  it('never asks for more output than the window holds', async () => {
    // The one bound this adapter can enforce from its own inputs: a request for
    // more completion tokens than the model's whole capacity cannot be served,
    // whoever declared it. Whether the route can COMPACT is `compaction-basic`'s
    // question — it owns the headroom and retention settings the answer depends
    // on — so that is deliberately not decided here.
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({
        data: [
          { id: 'at-window', limits: { context_window: 131_072, max_completion_tokens: 131_072 } },
          { id: 'over-window', limits: { context_window: 131_072, max_completion_tokens: 999_999_999 } },
        ],
      }),
    })
    const adapter = makeAdapter()

    expect((await adapter.resolveModel('aishell', 'at-window')).defaultMaxTokens).toBe(131_072)
    expect((await adapter.resolveModel('aishell', 'over-window')).defaultMaxTokens).toBe(131_072)
  })

  it('leaves out a model with no context window, and says so once', async () => {
    // The gateway contract carries `limits.context_window` on every entry. One
    // that does not is a defect upstream: without a capacity the harness cannot
    // price the route, and `compaction-basic` refuses a switch to it outright
    // (`MODEL_SWITCH_COMPACTION_FAILED`). Offering it would put a model in the
    // picker that fails on the way to being used.
    const warn = vi.fn()
    const gateway = makeAdapter({ warn })

    fetchMock.mockResolvedValue(answering([
      { id: 'glm-5.2', limits: { context_window: 131072 } },
      { id: 'glm-broken' },
    ]))
    expect((await gateway.listModels('aishell')).map(m => m.id)).toEqual(['glm-5.2'])
    expect(warn).toHaveBeenCalledOnce()
    expect(warn.mock.calls[0]![0]).toContain('glm-broken')
    expect(warn.mock.calls[0]![0]).toContain('limits.context_window')

    // Every refresh sees the defect again; reporting it each time would bury
    // the line in its own repetition.
    agePastTtl()
    await gateway.listModels('aishell')
    await settle()
    expect(warn).toHaveBeenCalledOnce()
  })

  it('drops a model that went malformed from the picker, and still resolves its last good capacity', async () => {
    // The two halves of the record answer different questions: `models` is
    // what the picker OFFERS, `known` is what is TRUE about a model. A model
    // the gateway stopped describing properly is no longer offerable, but a
    // Turn running against it still needs the capacity it was listed with.
    const gateway = makeAdapter()
    fetchMock.mockResolvedValueOnce(answering([{ id: 'glm-5.2', limits: { context_window: 4096 } }]))
    await gateway.listModels('aishell')

    agePastTtl()
    fetchMock.mockResolvedValueOnce(answering([{ id: 'glm-5.2' }]))
    await gateway.listModels('aishell')
    await settle()

    expect(await gateway.listModels('aishell')).toEqual([])
    expect((await gateway.resolveModel('aishell', 'glm-5.2')).context).toEqual({ contextWindow: 4096 })
  })

  it('does not let a malformed entry overwrite what the model was last listed with', async () => {
    // `known` is what keeps a just-retired model's capacity alive. A reading
    // that has no capacity to offer must not replace one that did — that would
    // lose exactly what the index exists to preserve.
    const gateway = makeAdapter()
    fetchMock.mockResolvedValueOnce(answering([{ id: 'glm-5.2', limits: { context_window: 4096 } }]))
    await gateway.listModels('aishell')

    agePastTtl()
    fetchMock.mockResolvedValueOnce(answering([{ id: 'glm-5.2' }]))
    await gateway.listModels('aishell')
    await settle()

    expect((await gateway.resolveModel('aishell', 'glm-5.2')).context).toEqual({ contextWindow: 4096 })
  })

  it('reports a re-costed model as a change', async () => {
    // A model staying in the catalog with a new context window or reasoning
    // ladder is the same kind of change as one appearing: the picker shows
    // both, so comparing ids alone would miss it.
    const onCatalogChanged = vi.fn()
    const gateway = makeAdapter({ onCatalogChanged })

    fetchMock.mockResolvedValueOnce(answering([{ id: 'glm-5.2', limits: { context_window: 4096 } }]))
    await gateway.listModels('aishell')

    agePastTtl()
    fetchMock.mockResolvedValueOnce(answering([{ id: 'glm-5.2', limits: { context_window: 8192 } }]))
    await gateway.listModels('aishell')
    await settle()
    expect(onCatalogChanged).toHaveBeenCalledOnce()
  })
})

describe('GatewayAdapter — stream', () => {
  beforeEach(() => {
    keyringStore.clear()
    fetchMock.mockReset()
  })

  it('POSTs /chat/completions with AK/SK signing (not Bearer)', async () => {
    const adapter = makeAdapter()
    const ssePayloads = [
      JSON.stringify({ choices: [{ delta: { content: 'Hello' } }] }),
      JSON.stringify({ choices: [{ finish_reason: 'stop' }] }),
      '[DONE]',
    ]
    fetchMock.mockResolvedValueOnce({
      ok: true,
      body: sseStream(ssePayloads),
      text: async () => '',
    })

    const chunks: StreamChunk[] = []
    for await (const chunk of adapter.stream(baseOptions)) {
      chunks.push(chunk)
    }

    expect(fetchMock).toHaveBeenCalledOnce()
    const [url, init] = fetchMock.mock.calls[0]!
    expect(String(url)).toBe(`${BASE_URL}/chat/completions`)
    expect(init.method).toBe('POST')
    // Authorization must be SDK-HMAC-SHA256, not Bearer
    expect(init.headers.Authorization).toMatch(/^SDK-HMAC-SHA256 /)
    expect(init.headers.Authorization).not.toContain('Bearer')
    // x-sdk-date must be present
    expect(init.headers['x-sdk-date']).toBeTruthy()

    const types = chunks.map(c => c.type)
    expect(types[types.length - 1]).toBe('finish')
  })

  it('throws MISSING_CREDENTIAL when no AK/SK', async () => {
    const adapter = makeAdapter({ noCredentials: true })
    let caught: unknown
    try {
      for await (const _ of adapter.stream(baseOptions)) { void _ }
    } catch (error: unknown) {
      caught = error
    }
    // The class matters, not just the text: `MISSING_CREDENTIAL` names a
    // configuration fact the user can fix, while `TRANSPORT` names a transient
    // fault and is retried. Asserting on the message alone lets a re-wrap
    // through.
    expect(caught).toBeInstanceOf(LlmError)
    expect((caught as LlmError).code).toBe('MISSING_CREDENTIAL')
    // What the message must SAY: the condition the person is in.
    expect((caught as Error).message).toMatch(/not authenticated with Huawei Cloud IAM/)
    expect((caught as Error).message).not.toMatch(/request failed/)
    // What it must NOT say. This reaches the chat pane, so it must describe the
    // user's situation and nothing about how the adapter is built. The list is
    // the exact set the previous version leaked — storage keys, the credential
    // store, the keyring service name, and an internal setup instruction — and
    // it is asserted rather than left to review, because the natural way to
    // make such a message "more helpful" is to put all four back.
    for (const leak of [
      /HW_ACCESS_KEY/, /HW_SECRET_KEY/, /HW_SECURITY_TOKEN/,
      /credential store/i, /keyring/i, /aishell-dsh-plugins/,
      /store them/i,
    ]) {
      expect((caught as Error).message).not.toMatch(leak)
    }
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('throws a status-named code on non-ok response', async () => {
    const adapter = makeAdapter()
    fetchMock.mockResolvedValueOnce({ ok: false, status: 403, text: async () => 'forbidden' })
    await expect(adapter.stream(baseOptions)[Symbol.asyncIterator]().next()).rejects.toThrow('gateway returned 403')
  })

  it('appends the supported model list to a model_not_found rejection', async () => {
    // The pinned default model id going stale is the failure this diagnoses:
    // the gateway drops the id, every fresh session gets AISHELL.1004, and the
    // error must name what the gateway currently accepts instead.
    //
    // The body is verbatim from the live gateway (and the shape its
    // `internal/apierr` package renders). The previous fixture used
    // `502` + `"code":"4005"`, which no gateway has answered since the code
    // contract landed — so the diagnosis was dead and the test proved only
    // that dead code stays dead.
    const adapter = makeAdapter()
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 404,
      text: async () => '{"error":{"message":"unknown model: glm-5.2","type":"invalid_request_error",'
        + '"code":"model_not_found"},"error_code":"AISHELL.1004","error_msg":"unknown model: glm-5.2"}',
    })
    // The diagnostic's catalog fetch (served from the adapter's TTL cache
    // after this one signed GET).
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ data: [{ id: 'glm-5.3-flash', limits: { context_window: 1048576 } }] }),
    })
    const error = await adapter.stream(baseOptions)[Symbol.asyncIterator]().next().then(
      () => { throw new Error('expected the stream to reject') },
      (e: unknown) => e as Error,
    )
    expect(error.message).toContain('gateway returned 404')
    expect(error.message).toContain('currently supports: glm-5.3-flash')
    expect(error.message).toContain('Requested: glm-5.2')
  })

  it('recognizes the rejection by the canonical error_code alone', async () => {
    // `apierr/codes.go` designates `error_code` the contract and `error.code`
    // the OpenAI-compatibility echo. A proxy that rewrites or drops the inner
    // object must not silently disable the diagnosis, so either field alone
    // is enough.
    const adapter = makeAdapter()
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 404,
      text: async () => '{"error_code":"AISHELL.1004","error_msg":"model not configured"}',
    })
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ data: [{ id: 'glm-5.3-flash', limits: { context_window: 1048576 } }] }),
    })
    const error = await adapter.stream(baseOptions)[Symbol.asyncIterator]().next().then(
      () => { throw new Error('expected the stream to reject') },
      (e: unknown) => e as Error,
    )
    expect(error.message).toContain('currently supports: glm-5.3-flash')
  })

  it('leaves an unrelated failure alone even when its body carries a code', async () => {
    // The guard must be the model-not-found fact, not "any structured error".
    // A 500 with its own code is a different problem with a different remedy.
    const adapter = makeAdapter()
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 500,
      text: async () => '{"error":{"message":"internal gateway error","type":"api_error",'
        + '"code":"internal_error"},"error_code":"AISHELL.3002"}',
    })
    await expect(adapter.stream(baseOptions)[Symbol.asyncIterator]().next()).rejects.toThrow(
      'gateway returned 500: {"error":{"message":"internal gateway error","type":"api_error",'
      + '"code":"internal_error"},"error_code":"AISHELL.3002"}',
    )
  })

  it('keeps the plain gateway message when the catalog answers nothing', async () => {
    const adapter = makeAdapter()
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 404,
      text: async () => '{"error":{"message":"unknown model: glm-5.2","type":"invalid_request_error",'
        + '"code":"model_not_found"},"error_code":"AISHELL.1004","error_msg":"unknown model: glm-5.2"}',
    })
    fetchMock.mockResolvedValueOnce({ ok: false, status: 403 })
    await expect(adapter.stream(baseOptions)[Symbol.asyncIterator]().next()).rejects.toThrow(
      'gateway returned 404: {"error":{"message":"unknown model: glm-5.2","type":"invalid_request_error",'
      + '"code":"model_not_found"},"error_code":"AISHELL.1004","error_msg":"unknown model: glm-5.2"}',
    )
  })
})

describe('GatewayAdapter — STS token', () => {
  beforeEach(() => {
    keyringStore.clear()
    fetchMock.mockReset()
  })

  it('includes x-security-token header when STS token is stored', async () => {
    const keyring = createCredentialsStore()
    keyring.set('HW_ACCESS_KEY', 'test-ak')
    keyring.set('HW_SECRET_KEY', 'test-sk')
    keyring.set('HW_SECURITY_TOKEN', 'test-sts-token')
    const adapter = new GatewayAdapter({
      resolveBaseUrl: () => BASE_URL,
      keyring,
      resolveImageBudget: () => IMAGE_BUDGET,
      resolveMaxRequestImageBytes: () => MAX_REQUEST_IMAGE_BYTES,
    })

    fetchMock.mockResolvedValueOnce({
      ok: true,
      body: sseStream([
        JSON.stringify({ choices: [{ delta: { content: 'ok' } }] }),
        JSON.stringify({ choices: [{ finish_reason: 'stop' }] }),
        '[DONE]',
      ]),
      text: async () => '',
    })
    for await (const _ of adapter.stream(baseOptions)) { void _ }

    const init = fetchMock.mock.calls[0]![1]
    expect(init.headers['x-security-token']).toBe('test-sts-token')
  })
})

// ── image input ──

describe('GatewayAdapter — image input', () => {
  beforeEach(() => {
    keyringStore.clear()
    fetchMock.mockReset()
  })

  /**
   * Stub attachment service returning fixed bytes. The real backend needs a
   * DSH home, a decode pipeline and normalization; what matters here is that
   * the adapter asks it for the right reference and carries the answer to the
   * wire.
   */
  function stubAttachments(byteLength = 4) {
    const reads: Array<{ id: string; target: { width: number; height: number; maxBytes: number } }> = []
    return {
      reads,
      store: {
        readImageRequest: async (
          ref: { attachmentId: string; width: number; height: number },
          target: { width: number; height: number; maxBytes: number },
        ) => {
          reads.push({ id: ref.attachmentId, target })
          return {
            variantId: `v-${ref.attachmentId}`,
            attachment: ref,
            data: Uint8Array.from({ length: byteLength }, (_, i) => i),
            mediaType: 'image/png',
            bytes: byteLength,
            width: target.width,
            height: target.height,
            depth: 'uchar',
            space: 'srgb',
            hasAlpha: false,
          }
        },
        // Present so the adapter's handle-text path resolves; `undefined`
        // stands for a backend with no host-file mapping, which is exactly the
        // shorter handle-text form. The real store implements this.
        imageHostPath: () => undefined,
      },
    }
  }

  const imageBlock = (id = 'sha256:aaaaaaaaaaaaaaaa') => ({
    type: 'image',
    attachment: { attachmentId: id, mediaType: 'image/png', bytes: 4, width: 10, height: 10 },
  })

  function imageOptions(): GenerateOptions {
    return {
      ...baseOptions,
      messages: [createUserMessage({
        source: { kind: 'user' },
        content: [{ type: 'text', text: 'describe this' }, imageBlock()] as never,
      })],
    }
  }

  function okStream() {
    return {
      ok: true,
      body: sseStream([
        JSON.stringify({ choices: [{ delta: { content: 'ok' } }] }),
        JSON.stringify({ choices: [{ finish_reason: 'stop' }] }),
        '[DONE]',
      ]),
      text: async () => '',
    }
  }

  it('sends the image as a base64 image_url part', async () => {
    const { store, reads } = stubAttachments()
    const adapter = makeAdapter({ resolveAttachments: () => store })
    fetchMock.mockResolvedValueOnce(okStream())
    for await (const _ of adapter.stream(imageOptions())) { void _ }

    expect(reads).toHaveLength(1)
    expect(reads[0]!.id).toBe('sha256:aaaaaaaaaaaaaaaa')
    const body = JSON.parse(fetchMock.mock.calls[0]![1].body as string)
    const parts = body.messages[0].content
    expect(Array.isArray(parts)).toBe(true)
    expect(parts.some((p: { type: string }) => p.type === 'image_url')).toBe(true)
    expect(parts.find((p: { type: string }) => p.type === 'image_url').image_url.url)
      .toBe('data:image/png;base64,AAECAw==')
  })

  it('encodes an image whose bytes cross the chunk boundary intact', async () => {
    // `dataUrl` converts the byte string in fixed chunks rather than one
    // `String.fromCharCode` per byte. The boundary is where that rewrite can go
    // wrong — a stray offset drops or duplicates a byte and the base64 is
    // subtly corrupt, which no round trip through the wire would catch here.
    // The byte pattern is chosen so a shifted window changes the answer.
    const byteLength = 0x8000 + 17
    const { store } = stubAttachments(byteLength)
    const adapter = makeAdapter({ resolveAttachments: () => store })
    fetchMock.mockResolvedValueOnce(okStream())
    for await (const _ of adapter.stream(imageOptions())) { void _ }

    const body = JSON.parse(fetchMock.mock.calls[0]![1].body as string)
    const parts = body.messages[0].content
    const url: string = parts.find((p: { type: string }) => p.type === 'image_url').image_url.url
    const base64 = url.slice('data:image/png;base64,'.length)

    // Decode and compare against the bytes the stub served, so a dropped or
    // duplicated chunk boundary shows up as a length or content mismatch.
    const decoded = Buffer.from(base64, 'base64')
    expect(decoded).toHaveLength(byteLength)
    expect(decoded).toEqual(Buffer.from(Uint8Array.from({ length: byteLength }, (_, i) => i % 256)))
  })

  it('still sends plain-string content for text-only history', async () => {
    // The regression guard: image plumbing must not reshape ordinary requests.
    const adapter = makeAdapter()
    fetchMock.mockResolvedValueOnce(okStream())
    for await (const _ of adapter.stream(baseOptions)) { void _ }
    const body = JSON.parse(fetchMock.mock.calls[0]![1].body as string)
    expect(body.messages[0].content).toBe('hello')
  })

  it('fails with UNSUPPORTED_CONTENT when no attachment service is mounted', async () => {
    const adapter = makeAdapter()
    await expect(adapter.stream(imageOptions())[Symbol.asyncIterator]().next())
      .rejects.toThrow(/requires the durable attachment service/)
  })

  it('hoists a tool-result image into a user turn, keeping the tool message textual', async () => {
    // OpenAI's tool message takes text only; the image rides the next user turn.
    const { store } = stubAttachments()
    const adapter = makeAdapter({ resolveAttachments: () => store })
    fetchMock.mockResolvedValueOnce(okStream())
    const options: GenerateOptions = {
      ...baseOptions,
      messages: [
        createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'shot?' }] }),
        {
          role: 'tool',
          toolCallId: 'call-1',
          content: [{ type: 'text', text: 'here it is' }, imageBlock('sha256:bbbbbbbbbbbbbbbb')],
        } as never,
      ],
    }
    for await (const _ of adapter.stream(options)) { void _ }
    const body = JSON.parse(fetchMock.mock.calls[0]![1].body as string)
    const tool = body.messages.find((m: { role: string }) => m.role === 'tool')
    expect(typeof tool.content).toBe('string')
    const hoisted = body.messages.find(
      (m: { role: string; content: unknown }) => m.role === 'user' && Array.isArray(m.content),
    )
    expect(hoisted).toBeDefined()
    expect(hoisted.content.some((p: { type: string }) => p.type === 'image_url')).toBe(true)
  })

  it('surfaces IMAGE_OFFLOAD_REQUIRED from a request over the byte budget', async () => {
    // This error is the contract with dsh-compaction-image-offload: it must
    // escape stream() as a classified LlmError, not as a bare throw.
    const { store } = stubAttachments(64)
    const adapter = makeAdapter({ resolveAttachments: () => store, maxRequestImageBytes: 10 })
    let caught: unknown
    try {
      for await (const _ of adapter.stream(imageOptions())) { void _ }
    } catch (error: unknown) {
      caught = error
    }
    expect(caught).toBeInstanceOf(LlmError)
    expect((caught as LlmError).code).toBe('IMAGE_OFFLOAD_REQUIRED')
    expect((caught as LlmError).failure.offloadImages).toBe(1)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('does not relabel an attachment-backend failure as a network error', async () => {
    // The attachment read is not transport. If its failure were funnelled
    // through the fetch catch, a storage error would wear `TRANSPORT` — a code
    // the retry policy treats as transient — and the real cause would be
    // invisible while the request was retried for a fault retrying cannot fix.
    const failing = {
      readImageRequest: async () => { throw new Error('keyring unavailable') },
    }
    const adapter = makeAdapter({ resolveAttachments: () => failing as never })
    let caught: unknown
    try {
      for await (const _ of adapter.stream(imageOptions())) { void _ }
    } catch (error: unknown) {
      caught = error
    }
    expect(caught).toBeInstanceOf(Error)
    expect((caught as Error).message).toMatch(/keyring unavailable/)
    expect((caught as Error).message).not.toMatch(/request failed/)
    // Not `TRANSPORT`: that code is in the retry policy's eligible set, so a
    // storage fault wearing it would be retried as a network fault — five more
    // attempts at something retrying cannot fix.
    expect((caught as { code?: string }).code).not.toBe('TRANSPORT')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('never sends an unprepared image: a missing version fails before the request', async () => {
    const { store } = stubAttachments()
    // A service that silently returns nothing for the requested id.
    const emptyStore = {
      readImageRequest: async () => { throw new Error('no such attachment') },
    }
    const adapter = makeAdapter({ resolveAttachments: () => store })
    fetchMock.mockResolvedValueOnce(okStream())
    // Sanity: the well-behaved store does reach the wire.
    for await (const _ of adapter.stream(imageOptions())) { void _ }
    expect(fetchMock).toHaveBeenCalledTimes(1)

    const broken = makeAdapter({ resolveAttachments: () => emptyStore as never })
    await expect(broken.stream(imageOptions())[Symbol.asyncIterator]().next())
      .rejects.toThrow(/no such attachment/)
  })
})

describe('GatewayAdapter — configuration stays live', () => {
  beforeEach(() => {
    keyringStore.clear()
    fetchMock.mockReset()
  })

  /** Streams one trivial completion, so `signedFetch` runs and records a call. */
  async function drain(adapter: GatewayAdapter): Promise<void> {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      body: sseStream([
        JSON.stringify({ choices: [{ delta: { content: 'ok' } }] }),
        JSON.stringify({ choices: [{ finish_reason: 'stop' }] }),
        '[DONE]',
      ]),
      text: async () => '',
    })
    for await (const _ of adapter.stream(baseOptions)) { void _ }
  }

  it('uses the endpoint the reader returns now, not the one it was built with', async () => {
    // The bug this guards: every field of this plugin's Config is Volatile, so
    // a settings edit is a volatile-only loader update — it commits into the
    // existing references and returns without re-running apply()
    // (cordis-plugin-loader/lib/index.js:381-388). The adapter therefore
    // outlives its construction-time values, and capturing them left the
    // settings surface and the wire disagreeing until a restart.
    let baseUrl = 'https://old.example.com/v1'
    const adapter = makeAdapter({ baseUrl: () => baseUrl })

    await drain(adapter)
    expect(String(fetchMock.mock.calls[0]![0])).toBe('https://old.example.com/v1/chat/completions')

    baseUrl = 'https://new.example.com/v1'
    await drain(adapter)
    expect(String(fetchMock.mock.calls[1]![0])).toBe('https://new.example.com/v1/chat/completions')
  })

  it('signs against the endpoint it actually requests after an edit', async () => {
    // Re-reading the URL is not enough: the signature covers the canonical URI,
    // so the path has to come from the same URL the request uses. Time is
    // frozen so the recomputation is byte-identical rather than lucky.
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-10-13T00:00:00Z'))
    try {
      await signingAfterEdit()
    } finally {
      vi.useRealTimers()
    }
  })

  async function signingAfterEdit(): Promise<void> {
    let baseUrl = 'https://old.example.com/v1'
    const adapter = makeAdapter({ baseUrl: () => baseUrl })

    await drain(adapter)
    baseUrl = 'https://new.example.com/v2'
    await drain(adapter)

    const [url, init] = fetchMock.mock.calls[1]!
    const requestUrl = new URL(String(url))
    expect(requestUrl.pathname).toBe('/v2/chat/completions')

    const { sign } = await import('@huaweidevtools/aishell-dsh-credentials-store/signer')
    const expected = sign('POST', requestUrl.host, requestUrl.pathname, {}, init.body as string,
      { ak: 'test-ak', sk: 'test-sk' })
    expect(init.headers.Authorization).toBe(expected.Authorization)
  }
})
