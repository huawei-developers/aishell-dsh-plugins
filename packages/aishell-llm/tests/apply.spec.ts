/**
 * apply() registration behavior.
 *
 * What these pin: the `aishell` route registers BOTH as a live adapter and as
 * a configurable-provider directory entry — the Models page joins the two, and
 * before the directory entry existed the page showed nothing for the route.
 * The entry's settings namespace must follow the Loader row id (it is what a
 * configuration surface addresses edits by), and the schema must exist for
 * the settings mirror to list the namespace at all. The browser half carries
 * no registration of its own — the Models row is shadowed at runtime (see
 * provider-row-shadow.spec.ts) — so this file pins the Host half alone.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { LlmConfigurableProvider } from '@deepseek-ai/dsh-llm'

// The keyring seam must be stubbed BEFORE the adapter module constructs any
// store (see vitest.setup.ts for why vi.mock cannot be used here).
const { keyringStore } = vi.hoisted(() => ({ keyringStore: new Map<string, string>() }))

class MockEntry {
  constructor(private readonly service: string, private readonly account: string) {}
  private key(): string { return `${this.service}:${this.account}` }
  setPassword(value: string): void { keyringStore.set(this.key(), value) }
  getPassword(): string | null { return keyringStore.get(this.key()) ?? null }
  deletePassword(): void { keyringStore.delete(this.key()) }
}

const { __setKeyringModule } = await import('@huaweidevtools/aishell-dsh-credentials-store')
__setKeyringModule({ Entry: MockEntry })

const { apply, Config, PROVIDER, PROVIDER_DISPLAY_NAME } = await import('../src/index.ts')

/** One adapter registration the stubbed llm service recorded. */
interface AdapterRegistration {
  readonly providers: readonly string[]
  readonly adapter: object
}

/** One directory registration the stubbed llm service recorded. */
let directory: LlmConfigurableProvider[] | undefined

/** Minimal Context exposing only what apply() touches. */
function makeCtx(entryId: string | undefined): { ctx: never, registered: AdapterRegistration[] } {
  const registered: AdapterRegistration[] = []
  directory = undefined
  const ctx = {
    fiber: entryId === undefined
      ? {}
      : { entry: { options: { id: entryId } } },
    llm: {
      registerAdapter: (providers: readonly string[], adapter: object) => {
        registered.push({ providers, adapter })
        return () => {}
      },
      registerConfigurableProviders: (entries: readonly LlmConfigurableProvider[]) => {
        directory = [...entries]
        return () => { directory = undefined }
      },
    },
    effect: (fn: () => (() => void) | void) => { fn() },
  }
  return { ctx: ctx as never, registered }
}

beforeEach(() => {
  keyringStore.clear()
})

describe('aishell-llm — apply registrations', () => {
  it('registers the aishell route as a live adapter', () => {
    const { ctx, registered } = makeCtx('aishell-llm')
    apply(ctx, Config({}))
    expect(registered).toHaveLength(1)
    expect(registered[0]!.providers).toEqual(['aishell'])
    expect(PROVIDER).toBe('aishell')
  })

  it('declares the route in the configurable-provider directory under the Loader row id', () => {
    // The aggregate bundle keeps the row id `aishell-llm`, so the same code
    // path serves standalone and bundled installs with one namespace.
    const { ctx } = makeCtx('aishell-llm')
    apply(ctx, Config({}))
    expect(directory).toEqual([{
      provider: 'aishell',
      displayName: PROVIDER_DISPLAY_NAME,
      settingsNs: 'aishell-llm',
      settingsPath: [],
    }])
  })

  it('falls back to the plugin name when mounted without a Loader row', () => {
    const { ctx } = makeCtx(undefined)
    apply(ctx, Config({}))
    expect(directory?.[0]?.settingsNs).toBe('aishell-llm')
  })

  it('reads its endpoint from the Config schema, whose defaults serve an empty profile', () => {
    // The Models row's existence depends on the settings mirror listing this
    // namespace, and the mirror only lists plugins that declare a schema —
    // so the schema itself (not just the values) is load-bearing.
    expect(Config({})).toMatchObject({ baseUrl: { get: expect.any(Function) } })
    const { ctx } = makeCtx('aishell-llm')
    apply(ctx, Config({}))
    // A resolved default profile must not sign requests at a blank endpoint.
    const resolved = Config({})
    expect(resolved.baseUrl.get()).toBe('https://openai.aishell.openbuildlab.com/v1')
  })
})
