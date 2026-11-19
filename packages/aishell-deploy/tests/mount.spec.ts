/**
 * aishell-deploy mount contract.
 *
 * The plugin registers its tools directly on the harness registry. What matters
 * here follows from that:
 *
 *   1. The 18 tools register, under `aishell__` names, with a JSON Schema the
 *      model can read.
 *   2. The credential source is the plugin's own store, read per call — a
 *      rotation applies to the next call with nothing rebuilt.
 *   3. The permission route and the policy context read the same module state
 *      the gate enforces, so the switch cannot describe a mode the tools do not
 *      honour.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { writeHuaweiCloud } from '@huaweidevtools/aishell-dsh-credentials-store/accounts'

/**
 * Backing map for the mocked store, keyed by entry name.
 *
 * The plugin reads through the shared bundle module, so a test plants values by
 * calling `writeHuaweiCloud(store, …)` — the same writer the credential form
 * uses. Planting raw entry names would test a layout nothing writes.
 */
const credentials = new Map<string, string>()

/** A store-shaped view over `credentials`, as `createCredentialsStore` returns. */
const store = {
  get: (account: string) => credentials.get(account),
  set: (account: string, value: string) => { credentials.set(account, value) },
  delete: (account: string) => { credentials.delete(account) },
  has: (account: string) => credentials.has(account),
}

vi.mock('@huaweidevtools/aishell-dsh-credentials-store', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@huaweidevtools/aishell-dsh-credentials-store')>()
  return {
    ...actual,
    createCredentialsStore: () => store,
  }
})

/** The settings document's `aishell-client-credentials` value, as it holds it. */
let credentialsSettings: Record<string, unknown> | undefined

/** Audit records the plugin wrote, when the audit service is mounted. */
let auditRecords: Array<Record<string, unknown>> = []

/** The audit service a mounted deployment provides, or `undefined`. */
let auditService: { record: (event: Record<string, unknown>) => void } | undefined

/** Definitions registered on the stubbed tool registry. */
let definitions: Array<{
  name: string
  description: string
  parameters: Record<string, unknown>
  timeoutMs?: number
  output: { schema: Record<string, unknown>, render: (args: unknown, value: unknown) => unknown }
  execute: (args: unknown, exec: unknown) => Promise<unknown>
}> = []

/** Routes registered on the stubbed connection service, by path. */
const registeredRoutes = new Map<string, {
  methods: readonly string[]
  fetch?: (request: Request) => Promise<Response>
}>()

/** The policy contribution registered on the stubbed system prompt, if any. */
let liveSessions: string[] = []
let policyContext: { name: string, order: number, text: (context: { agent?: { id?: unknown } }) => string } | undefined
/** Scope names for which the tool registry reports nothing visible. */
let restrictedScopes = new Set<string>()
/**
 * Individual tools the registry reports as not visible, in every scope.
 *
 * A narrowed agent: the plugin mounted, most tools available, a few withheld.
 * Distinct from `restrictedScopes`, which withholds the whole set.
 */
let hiddenTools = new Set<string>()
/** The workflow section registered on the stubbed system prompt, if any. */
let workflowSection: {
  name: string
  order: number
  interpolate?: boolean
  text: (args: { scope?: unknown }) => string
} | undefined
/** Event listeners registered through `ctx.on`. */
const listeners = new Map<string, Array<(...args: unknown[]) => void>>()

const { apply } = await import('../src/index.ts')
const modeModule = await import('../src/permission/mode.ts')

/** Minimal Context exposing only what apply() touches. */
function makeCtx(): { ctx: never, logger: { info: ReturnType<typeof vi.fn>, warn: ReturnType<typeof vi.fn>, error: ReturnType<typeof vi.fn> } } {
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
  const ctx = {
    // `ctx.logger(name)` is a function returning a scoped logger; a stub that
    // made it a property would pass a different call shape than the real one.
    logger: () => logger,
    effect: (fn: () => (() => void)) => { fn() },
    // Services resolve through `ctx.get`. `audit` is present unless a test
    // says otherwise: its absence is its own case (see permission-audit.spec).
    // `settings` exposes only what this plugin reads from it.
    get: (name: string) => {
      if (name === 'audit') return auditService
      if (name === 'settings') {
        return {
          describe: () => credentialsSettings === undefined
            ? []
            : [{ ns: 'aishell-client-credentials', value: credentialsSettings }],
        }
      }
      return undefined
    },
    tools: {
      // Scoped lookup, as the real registry provides. Two ways a tool is not
      // visible, and they are different cases: a scope in `restrictedScopes`
      // sees nothing (the whole plugin was withheld), while `hiddenTools` names
      // individual tools an agent may not call. The second is what a narrowed
      // toolset looks like, and it is the case the workflow section has to
      // survive without losing the guidance for the tools that remain.
      get: (name: string, scope?: unknown) => {
        const label = (scope as { agent?: string } | undefined)?.agent
        if (label !== undefined && restrictedScopes.has(label)) return undefined
        if (hiddenTools.has(name)) return undefined
        return definitions.find(entry => entry.name === name)
      },
      register: (definition: (typeof definitions)[number]) => {
        definitions.push(definition)
        return () => { definitions = definitions.filter(entry => entry !== definition) }
      },
    },
    connection: {
      fetch: {
        register: (route: { path: string, methods: readonly string[], fetch?: (request: Request) => Promise<Response> }) => {
          registeredRoutes.set(route.path, route)
          return () => { registeredRoutes.delete(route.path) }
        },
      },
    },
    // Sessions live in the store when the plugin mounts. The store announces
    // creation, so these are the ones that must be read back rather than waited
    // for.
    sessions: {
      list: () => liveSessions.map(id => ({ id })),
      get: (id: string) => (liveSessions.includes(id) ? { id } : undefined),
    },
    on: (event: string, listener: (...args: unknown[]) => void) => {
      const existing = listeners.get(event) ?? []
      listeners.set(event, [...existing, listener])
      return () => {
        listeners.set(event, (listeners.get(event) ?? []).filter(entry => entry !== listener))
      }
    },
    // The real service resolves `ctx.inject` immediately when the dependency is
    // present, which is the case this stub models.
    // `ctx.inject(deps, cb)` runs `cb` with a child context that has the
    // requested services. Two are requested by this plugin, and each test shape
    // decides what the child sees: the prompt scope always exists, and `audit`
    // exists only when the test mounted the audit plugin.
    inject: (deps: string[], fn: (scope: unknown) => void) => {
      if (deps.includes('audit') && auditService === undefined) return
      fn({
        effect: (effect: () => (() => void)) => { effect() },
        ...(deps.includes('audit') && auditService !== undefined
          ? { audit: auditService }
          : {}),
        systemPrompt: {
          context: (contribution: { name: string, order: number, text: (context: { agent?: { id?: unknown } }) => string }) => {
            policyContext = contribution
            return () => { policyContext = undefined }
          },
          section: (contribution: {
            name: string
            order: number
            interpolate?: boolean
            text: (args: { scope?: unknown }) => string
          }) => {
            workflowSection = contribution
            return () => { workflowSection = undefined }
          },
          getContextOrder: () => 115,
          getSectionOrder: () => 3100,
        },
      })
    },
  }
  return { ctx: ctx as never, logger }
}

/** Config as the loader supplies it: every field readable. */
function makeConfig(overrides: { region?: string | undefined, timeoutMs?: number } = {}): never {
  // No built-in region: the fixture passes through exactly what a profile
  // would, so "unset" is representable. Defaulting here would hide the very
  // distinction the plugin no longer makes on its own.
  return {
    defaultRegion: { get: () => overrides.region },
    // Mirrors `Config`'s default: ten minutes, because terraform runs are the
    // heaviest calls this plugin makes.
    toolCallTimeoutMs: { get: () => overrides.timeoutMs ?? 10 * 60 * 1000 },
  } as never
}

/** One registered definition by model-facing name. */
function tool(rawName: string) {
  const found = definitions.find(definition => definition.name === `aishell__${rawName}`)
  if (found === undefined) throw new Error(`tool ${rawName} was not registered`)
  return found
}

beforeEach(() => {
  credentials.clear()
  definitions = []
  registeredRoutes.clear()
  listeners.clear()
  liveSessions = []
  policyContext = undefined
  workflowSection = undefined
  restrictedScopes = new Set()
  hiddenTools = new Set()
  auditRecords = []
  auditService = { record: (event) => { auditRecords.push(event) } }
  credentialsSettings = undefined
  modeModule.resetMode()
})

describe('aishell-deploy — permission audit subject', () => {
  /** Trigger one audited switch with the given account state. */
  const switchMode = (ak: string | undefined, name: string | undefined): Record<string, unknown> => {
    credentials.clear()
    if (ak !== undefined) writeHuaweiCloud(store, { ak, sk: 'SK1' })
    credentialsSettings = name === undefined ? undefined : { accessKeyIdHint: name }
    auditRecords = []
    apply(makeCtx().ctx, makeConfig())
    modeModule.setMode('s1', 'read_write')
    return auditRecords[0]!
  }

  it('names the account and masks the key in the middle', () => {
    // The account name is what a reader recognises; the masked key is what
    // identifies it across records without the whole key persisting in a file.
    expect(switchMode('AKIDEXAMPLEVALUE', 'prod-account'))
      .toMatchObject({ subject: 'prod-account(AKID****ALUE)' })
  })

  it('falls back to the masked key when no account name has been recorded', () => {
    // The credentials plugin may not be mounted, and its first verification may
    // not have landed. The key still identifies the account, so the subject is
    // never absent.
    expect(switchMode('AKIDEXAMPLEVALUE', undefined))
      .toMatchObject({ subject: '(AKID****ALUE)' })
  })

  it('does not label an action that had no credential at all', () => {
    // A switch made while signed out governed no account; naming one would be
    // an attribution the record cannot support.
    expect(switchMode(undefined, undefined)).not.toHaveProperty('subject')
  })

  it('never shows a short key in full', () => {
    expect(switchMode('SHORT', 'acct')).toMatchObject({ subject: 'acct(****)' })
  })
})

describe('aishell-deploy — mount', () => {
  it('registers all 18 tools under the aishell namespace', () => {
    apply(makeCtx().ctx, makeConfig())

    expect(definitions).toHaveLength(18)
    for (const definition of definitions) {
      expect(definition.name).toMatch(/^aishell__[a-z_]+$/)
    }
    // The names a model will actually call.
    for (const expected of [
      'create_deployment', 'delete_deployment', 'validate_design', 'lookup_specs', 'price_resources',
      'apiexplorer', 'openapi_request', 'terraform_examples_export',
      'list_existing_resources', 'provider_schema', 'terraform_install',
      'terraform_init', 'terraform_plan', 'terraform_apply', 'terraform_destroy',
      'terraform_refresh', 'terraform_state', 'terraform_import',
    ]) {
      expect(definitions.map(definition => definition.name)).toContain(`aishell__${expected}`)
    }
  })

  it('does not register auth — it belongs to aishell-credentials', () => {
    // Two tools answering "who am I authenticated as", one in each package, is
    // the split this move exists to remove.
    apply(makeCtx().ctx, makeConfig())
    expect(definitions.map(definition => definition.name)).not.toContain('aishell__auth')
  })

  it('publishes a JSON Schema, not the zod object it came from', () => {
    apply(makeCtx().ctx, makeConfig())

    const apply_ = tool('terraform_apply')
    // The model receives `parameters`; a zod instance serialized as `{}` is the
    // failure this asserts against.
    expect(apply_.parameters).toMatchObject({ type: 'object' })
    const properties = apply_.parameters.properties as Record<string, unknown>
    expect(Object.keys(properties)).toEqual(['deployment', 'env'])
  })

  it('declares required parameters, which the zod schemas mark', () => {
    apply(makeCtx().ctx, makeConfig())

    const create = tool('create_deployment')
    expect(create.parameters.required).toEqual(['deployment'])
  })

  it('gives every tool the configured timeout', () => {
    apply(makeCtx().ctx, makeConfig({ timeoutMs: 900_000 }))

    for (const definition of definitions) expect(definition.timeoutMs).toBe(900_000)
  })

  it('carries the description through verbatim', () => {
    apply(makeCtx().ctx, makeConfig())

    // The description is what the model decides to call from; truncating or
    // summarizing it here would silently change the tool's usability.
    expect(tool('delete_deployment').description).toContain('Refuses if the deployment still')
  })
})

describe('aishell-deploy — the credential source', () => {
  it('reads the pair from the plugin store, per call', async () => {
    writeHuaweiCloud(store, { ak: 'AK1', sk: 'SK1' })
    apply(makeCtx().ctx, makeConfig())

    const { readStoredCredentials } = await import('../src/credentials.ts')
    // The pair and nothing else: a region is not a credential — it does not
    // enter the signature — so it does not ride on this value.
    expect(readStoredCredentials()).toEqual({ ak: 'AK1', sk: 'SK1' })

    // A rotation must be visible without rebuilding anything: nothing is cached.
    writeHuaweiCloud(store, { ak: 'AK2', sk: 'SK1' })
    expect(readStoredCredentials()).toMatchObject({ ak: 'AK2', sk: 'SK1' })
  })

  it('treats half a pair as no credentials', async () => {
    // The bundle refuses to hold half a pair, so this plants the malformed
    // record directly — the state a hand-edited or corrupt store could hold.
    writeHuaweiCloud(store, { ak: 'AK1', sk: 'SK1' })
    store.set('aishell-credential', Buffer.from(JSON.stringify({
      huaweicloud: { access_key: 'AK1' },
    })).toString('base64'))
    apply(makeCtx().ctx, makeConfig())

    const { readStoredCredentials } = await import('../src/credentials.ts')
    expect(readStoredCredentials()).toBeUndefined()
  })

  it('carries a stored SecurityToken and omits an absent one', async () => {
    writeHuaweiCloud(store, { ak: 'AK1', sk: 'SK1' })
    apply(makeCtx().ctx, makeConfig())

    const { readStoredCredentials } = await import('../src/credentials.ts')
    expect(readStoredCredentials()).not.toHaveProperty('securityToken')

    writeHuaweiCloud(store, { ak: 'AK1', sk: 'SK1', securityToken: 'STS1' })
    expect(readStoredCredentials()).toMatchObject({ securityToken: 'STS1' })
  })

  it('exposes a configured region separately from the credentials', async () => {
    // The region is configuration, not part of the pair: it is what terraform
    // is given as HW_REGION_NAME and what a plan naming no region falls back
    // to. Keeping the two apart is what lets one deployment span regions.
    writeHuaweiCloud(store, { ak: 'AK1', sk: 'SK1' })
    apply(makeCtx().ctx, makeConfig({ region: 'ap-southeast-3' }))

    const { readStoredCredentials, configuredRegion } = await import('../src/credentials.ts')
    expect(configuredRegion()).toBe('ap-southeast-3')
    expect(readStoredCredentials()).not.toHaveProperty('region')
  })

  it('reports no configured region rather than inventing one', async () => {
    // No default: an unset region means "each resource's plan decides". A
    // built-in cn-north-4 would price and provision a region nobody chose.
    writeHuaweiCloud(store, { ak: 'AK1', sk: 'SK1' })
    apply(makeCtx().ctx, makeConfig({ region: undefined }))

    const { configuredRegion } = await import('../src/credentials.ts')
    expect(configuredRegion()).toBeUndefined()
  })

  it('drops the cached account identity when credentials change', () => {
    apply(makeCtx().ctx, makeConfig())

    // The listener is the whole interface between this package and
    // aishell-credentials; if it is not wired, a rotated credential keeps being
    // recorded under the previous account.
    expect(listeners.get('aishell/credentials-updated')).toHaveLength(1)
  })
})

describe('aishell-deploy — the permission route', () => {
  it('registers GET and POST on one path', () => {
    apply(makeCtx().ctx, makeConfig())

    const route = registeredRoutes.get('/api/aishell/permission')
    expect(route).toBeDefined()
    // One registration per path: the registry keys on path and holds a method
    // set, so two would collide.
    expect(route?.methods).toEqual(['GET', 'POST'])
  })

  it('registers the posture on its own path', () => {
    // A caller cannot reach it by omitting a field from a conversation's
    // request, which is what makes "setting what new Sessions start in" a
    // decision somebody has to make deliberately.
    apply(makeCtx().ctx, makeConfig())

    const route = registeredRoutes.get('/api/aishell/permission/default')
    expect(route).toBeDefined()
    expect(route?.methods).toEqual(['GET', 'POST'])
  })

  it('reports the mode the gate is enforcing', async () => {
    liveSessions = ['s1']
    apply(makeCtx().ctx, makeConfig())

    const response = await registeredRoutes.get('/api/aishell/permission')?.fetch?.(
      new Request('http://localhost/api/aishell/permission?session=s1', { method: 'GET' }),
    )
    expect(await response?.json()).toEqual({ ok: true, mode: 'read_only' })
  })

  it('refuses a request that names no Session', async () => {
    // Answering one would report the posture as a conversation's own mode, and
    // the chip would render a switch nobody made.
    apply(makeCtx().ctx, makeConfig())

    const response = await registeredRoutes.get('/api/aishell/permission')?.fetch?.(
      new Request('http://localhost/api/aishell/permission', { method: 'GET' }),
    )
    expect(response?.status).toBe(400)
  })

  it('applies a switch to the state the gate reads', async () => {
    // The property that matters: after this POST, `writesAllowed()` — which the
    // gate calls — must agree with what the chip now shows.
    liveSessions = ['s1', 's2']
    apply(makeCtx().ctx, makeConfig())
    expect(modeModule.writesAllowed('s1')).toBe(false)

    const response = await registeredRoutes.get('/api/aishell/permission')?.fetch?.(
      new Request('http://localhost/api/aishell/permission', {
        method: 'POST',
        body: JSON.stringify({ session: 's1', mode: 'read_write' }),
      }),
    )

    expect(await response?.json()).toMatchObject({ ok: true, mode: 'read_write', changed: true })
    expect(modeModule.writesAllowed('s1')).toBe(true)
    // Another conversation is unaffected: the reason the mode is per Session.
    expect(modeModule.writesAllowed('s2')).toBe(false)
  })
})

describe('aishell-deploy — the read-only policy context', () => {
  it('announces read-only for a Session that starts read-only', () => {
    liveSessions = ['s1']
    apply(makeCtx().ctx, makeConfig())
    expect(policyContext?.text({ agent: { id: 's1' } })).toContain('read-only')
  })

  it('announces nothing for a Session in read-write', () => {
    // `''` drops the contribution: there is no "you may now write" line to go
    // stale.
    liveSessions = ['s1']
    modeModule.setMode('s1', 'read_write')
    apply(makeCtx().ctx, makeConfig())
    expect(policyContext?.text({ agent: { id: 's1' } })).toBe('')
  })

  it('answers each Session its own posture', () => {
    // The failure a process-wide mode made: one conversation's grant told
    // another's model it could write, which the gate then refused.
    liveSessions = ['s1', 's2']
    modeModule.setMode('s1', 'read_write')
    apply(makeCtx().ctx, makeConfig())
    expect(policyContext?.text({ agent: { id: 's1' } })).toBe('')
    expect(policyContext?.text({ agent: { id: 's2' } })).toContain('read-only')
  })

  it('follows a switch, so the prompt cannot invite what the gate refuses', async () => {
    liveSessions = ['s1']
    apply(makeCtx().ctx, makeConfig())
    expect(policyContext?.text({ agent: { id: 's1' } })).toContain('read-only')

    await registeredRoutes.get('/api/aishell/permission')?.fetch?.(
      new Request('http://localhost/api/aishell/permission', {
        method: 'POST',
        body: JSON.stringify({ session: 's1', mode: 'read_write' }),
      }),
    )

    expect(policyContext?.text({ agent: { id: 's1' } })).toBe('')
  })
})
describe('aishell-deploy — the workflow section', () => {
  it('registers under its own name, at the contributed-tools slot', () => {
    apply(makeCtx().ctx, makeConfig())

    expect(workflowSection?.name).toBe('aishell:deploy-workflow')
    // 3100 is the gap between the built-in per-tool narration (1000–3000) and
    // the SDK reference (5000) — where contributed tool guidance belongs. A
    // section that landed elsewhere would be read as policy or as reference.
    expect(workflowSection?.order).toBe(3100)
  })

  it('is not interpolated', () => {
    // An unknown `{{` in a section's text makes assembly throw inside the agent
    // step, where nothing catches it and the turn dies.
    apply(makeCtx().ctx, makeConfig())
    expect(workflowSection?.interpolate).toBe(false)
  })

  it('renders while the tools are reachable', () => {
    apply(makeCtx().ctx, makeConfig())

    const text = workflowSection?.text({ scope: { agent: 'a1' } }) ?? ''
    // The ordering constraint the tool descriptions cannot express: the design
    // is checked and drawn first, then recorded, then priced.
    expect(text).toContain('aishell__validate_design')
    expect(text).toContain('aishell__price_resources')
  })

  it('stays silent when the tools are restricted away', () => {
    // Guidance for tools the model cannot see invites it to try them. The
    // rendering scope is what distinguishes "not registered" from "registered
    // but not for this agent".
    apply(makeCtx().ctx, makeConfig())
    restrictedScopes.add('restricted')

    expect(workflowSection?.text({ scope: { agent: 'restricted' } })).toBe('')
    // And still renders for a scope that can see the tools, so the guard is
    // about visibility rather than about having been called with a scope.
    expect(workflowSection?.text({ scope: { agent: 'other' } })).not.toBe('')
  })

  it('stays silent when the tools were never registered', () => {
    apply(makeCtx().ctx, makeConfig())
    definitions = []

    expect(workflowSection?.text({ scope: undefined })).toBe('')
  })

  it('keeps the guidance for the tools a narrowed agent still has', () => {
    // The section is assembled from blocks, each declaring the tools it is
    // about. Guidance is dropped block by block, never all at once: a model
    // holding these tools with no instructions is worse off than one holding
    // none, because the tools look usable.
    apply(makeCtx().ctx, makeConfig())
    hiddenTools.add('aishell__terraform_apply')
    hiddenTools.add('aishell__terraform_destroy')

    const text = workflowSection?.text({ scope: undefined }) ?? ''
    expect(text).toContain('aishell__list_existing_resources')
    expect(text).toContain('aishell__validate_design')
    // ...and says nothing about the calls it cannot make.
    expect(text).not.toContain('aishell__terraform_apply')
    expect(text).not.toContain('aishell__terraform_destroy')
  })

  it('renumbers its steps so a shortened workflow reads as a sequence', () => {
    // A list that starts at 1 and jumps to 4 reads as missing instructions.
    apply(makeCtx().ctx, makeConfig())
    hiddenTools.add('aishell__terraform_apply')
    hiddenTools.add('aishell__terraform_destroy')

    const text = workflowSection?.text({ scope: undefined }) ?? ''
    const numbers = [...text.matchAll(/^(\d+)\. /gm)].map(match => Number(match[1]))
    expect(numbers.length).toBeGreaterThan(0)
    expect(numbers).toEqual(numbers.map((_, index) => index + 1))
  })

  it('names every tool by the name the model calls', () => {
    // A guide that names `terraform_apply` when the model must call
    // `aishell__terraform_apply` sends it to a tool that does not exist.
    apply(makeCtx().ctx, makeConfig())
    const text = workflowSection?.text({ scope: undefined }) ?? ''

    for (const raw of [
      'create_deployment', 'validate_design', 'lookup_specs', 'price_resources',
      'apiexplorer',
      'terraform_init', 'terraform_plan', 'terraform_apply', 'terraform_destroy',
      'terraform_refresh', 'terraform_state', 'terraform_import',
    ]) {
      expect(text).toContain(`aishell__${raw}`)
    }
    // And never the bare spelling, which no tool answers to.
    expect(text).not.toMatch(/(?<!aishell__)terraform_apply/)
  })
})

describe('aishell-deploy — Session lifetime', () => {
  it('pins a Session at creation, so a later posture change leaves it alone', () => {
    apply(makeCtx().ctx, makeConfig())
    // A Session that existed before the deployment raised the posture.
    listeners.get('session/created')?.forEach(listener => { listener({ id: 'existing' }) })

    modeModule.setDefaultPosture('read_write')
    listeners.get('session/created')?.forEach(listener => { listener({ id: 'fresh' }) })

    expect(modeModule.getMode('existing')).toBe('read_only')
    expect(modeModule.getMode('fresh')).toBe('read_write')
  })

  it('forgets a Session when it is disposed', () => {
    liveSessions = ['gone']
    apply(makeCtx().ctx, makeConfig())
    listeners.get('session/created')?.forEach(listener => { listener({ id: 'gone' }) })
    modeModule.setMode('gone', 'read_write')

    listeners.get('session/disposed')?.forEach(listener => { listener({ id: 'gone' }) })

    expect(modeModule.getMode('gone')).toBe('read_only')
  })
})

describe('aishell-deploy — Sessions that predate the plugin', () => {
  it('pins a Session that already existed when the plugin mounted', () => {
    // A conversation can predate the plugin, so its creation announcement
    // reached nobody. Reading the live Sessions back is what puts it under the
    // same rule as every other Session.
    liveSessions = ['pre-existing']
    apply(makeCtx().ctx, makeConfig())

    modeModule.setDefaultPosture('read_write')

    expect(modeModule.getMode('pre-existing')).toBe('read_only')
  })
})
