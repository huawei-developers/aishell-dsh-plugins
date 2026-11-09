/**
 * The plugin entry: what mounts, and what the prompt says.
 *
 * The one property worth a spec of its own is the guidance section's silence.
 * The section exists so the model knows a sandbox tier is available and when to
 * prefer it; it must therefore contribute nothing when that tier is not
 * actually reachable. The case that matters is a per-agent tool restriction:
 * another plugin can narrow one agent's toolset, and the global registration
 * stays visible to an unscoped lookup. A section that asked without the
 * rendering scope would announce the sandbox tools to an agent that cannot call
 * them, and the model would then plan around capabilities it does not have.
 *
 * The rest pins the mount itself — that activation registers the whole toolset
 * and does not throw on a deployment missing the optional services.
 */

import { describe, it, expect, beforeEach } from 'vitest'

/** Tool names the stub registry received. */
let registered: string[] = []
/** Sections the stub prompt accepted. */
let sections: Array<{ name: string, order: number, interpolate?: boolean, text: (args: { scope?: unknown }) => string }> = []
/** Whether the opt-in services are present. */
let hasSystemPrompt = true
/** Tool names the stub registry reports as visible for a scope. */
let visibleForScope: (name: string, scope: unknown) => boolean = () => true

/** Event handlers registered through `ctx.on`, by event name. */
let listeners = new Map<string, Array<() => void>>()

/** Minimal context exposing only what apply() touches. */
function makeCtx(): unknown {
  return {
    tools: {
      register: (definition: { name: string }) => {
        registered.push(definition.name)
        return () => { registered = registered.filter(name => name !== definition.name) }
      },
      get: (name: string, scope?: unknown) => (
        registered.includes(name) && visibleForScope(name, scope) ? { name } : undefined
      ),
    },
    effect: (fn: () => (() => void)) => { fn() },
    inject: (deps: readonly string[], fn: (scope: unknown) => void) => {
      if (deps.includes('systemPrompt') && !hasSystemPrompt) return
      fn({
        systemPrompt: {
          section: (section: (typeof sections)[number]) => {
            sections.push(section)
            return () => { sections = sections.filter(entry => entry !== section) }
          },
        },
      })
    },
    get: () => undefined,
    on: (event: string, handler: () => void) => {
      listeners.set(event, [...(listeners.get(event) ?? []), handler])
      return () => {
        listeners.set(event, (listeners.get(event) ?? []).filter(entry => entry !== handler))
      }
    },
  }
}

const { apply, name, SANDBOX_GUIDANCE, SANDBOX_SECTION_NAME } = await import('../src/index.ts')

/** Config with every field readable, as the loader supplies it. */
function makeConfig(): never {
  return {
    apiBaseUrl: { get: () => 'https://openapi.example.test' },
    domain: { get: () => 'aishell.example.test' },
    requestTimeoutMs: { get: () => 30_000 },
  } as never
}

beforeEach(() => {
  listeners = new Map()
  registered = []
  sections = []
  hasSystemPrompt = true
  visibleForScope = () => true
})

describe('aishell-e2b — mount', () => {
  it('registers the whole sandbox toolset', () => {
    apply(makeCtx() as never, makeConfig())

    expect(registered).toHaveLength(12)
    expect(registered).toContain('aishell__sandbox_create')
    expect(registered).toContain('aishell__sandbox_commands_run')
    expect(registered).toContain('aishell__sandbox_get_port_url')
  })

  it('activates without a system prompt', () => {
    // The prompt section is an enhancement; a deployment without one should
    // lose the guidance rather than the tools.
    hasSystemPrompt = false

    expect(() => { apply(makeCtx() as never, makeConfig()) }).not.toThrow()
    expect(registered).toHaveLength(12)
    expect(sections).toHaveLength(0)
  })

  it('contributes the tier guidance under its own section name', () => {
    apply(makeCtx() as never, makeConfig())

    expect(sections).toHaveLength(1)
    expect(sections[0]?.name).toBe(SANDBOX_SECTION_NAME)
    // Not interpolated: a stray `{{` in a section's text throws during
    // assembly, inside the agent step, where nothing catches it.
    expect(sections[0]?.interpolate).toBe(false)
  })
})

describe('aishell-e2b — the guidance section', () => {
  it('states the distinction between the two tiers', () => {
    // The section is the plugin's reason for existing: without it the model
    // has the tools and no basis for choosing them over provisioning real
    // resources. Both halves of the choice have to be legible.
    // Both ends of the choice have to be legible, stated by what the user
    // asked for rather than by lifecycle alone.
    expect(SANDBOX_GUIDANCE).toMatch(/web app|demo|service/i)
    expect(SANDBOX_GUIDANCE).toMatch(/production system/i)
  })

  it('tells the model to ask when the tier is not obvious, and to explain it', () => {
    // A silent tie-break is a decision the user never sees until the bill.
    expect(SANDBOX_GUIDANCE).toMatch(/ask the user/i)
    // And the explanation has to be in consequences, not product names.
    expect(SANDBOX_GUIDANCE).toMatch(/throwaway|costs nothing to discard/i)
    expect(SANDBOX_GUIDANCE).toMatch(/billed|cost money/i)
  })

  it('leads with the capability a sandbox has that this machine does not', () => {
    // A public address is the least ambiguous signal, so it comes first: work
    // that must end in a URL to open belongs in a sandbox.
    expect(SANDBOX_GUIDANCE).toMatch(/public address/i)
    expect(SANDBOX_GUIDANCE).toMatch(/URL/i)
    // And the sequence that produces one.
    expect(SANDBOX_GUIDANCE).toContain('aishell__sandbox_get_port_url')
    expect(SANDBOX_GUIDANCE).toContain('background: true')
  })

  it('forbids putting sensitive material in a sandbox', () => {
    // `get_port_url` makes what the sandbox serves publicly reachable, which
    // is what makes a sandbox useful and what makes it the wrong place for
    // anything private. The rule names the categories so it cannot be read as
    // "be careful" and ignored.
    expect(SANDBOX_GUIDANCE).toMatch(/Never put sensitive material/i)
    expect(SANDBOX_GUIDANCE).toMatch(/credential|key/i)
    expect(SANDBOX_GUIDANCE).toMatch(/personal data/i)
    expect(SANDBOX_GUIDANCE).toMatch(/political/i)
    // And it says why, in the terms that make it stick: a public URL cannot be
    // unpublished.
    expect(SANDBOX_GUIDANCE).toMatch(/publicly reachable|cannot be unpublished/i)
  })

  it('names the tools by the names the model calls', () => {
    // A guide that says `sandbox_create` when the tool is registered as
    // `aishell__sandbox_create` points at something that does not exist.
    expect(SANDBOX_GUIDANCE).toContain('aishell__sandbox_create')
    expect(SANDBOX_GUIDANCE).toContain('aishell__terraform_')
    expect(SANDBOX_GUIDANCE).not.toMatch(/(?<!aishell__)\bsandbox_create\b/)
  })

  it('does not restate the Terraform workflow', () => {
    // That lives in the deploy plugin's own section, which also states the
    // approvals each step needs. Two copies would drift.
    expect(SANDBOX_GUIDANCE).not.toMatch(/update_networking|update_cost|terraform_apply/)
  })

  it('renders when the sandbox tools are reachable', () => {
    apply(makeCtx() as never, makeConfig())

    expect(sections[0]?.text({ scope: { agent: 'a1' } })).toBe(SANDBOX_GUIDANCE)
  })

  it('renders nothing when the tools are absent from the registry entirely', () => {
    const ctx = makeCtx() as { tools: { register: unknown } }
    // A deployment that never registered them, modelled by clearing first.
    apply(ctx as never, makeConfig())
    registered = []

    expect(sections[0]?.text({ scope: undefined })).toBe('')
  })

  it('renders nothing when a scope has the tools restricted away', () => {
    apply(makeCtx() as never, makeConfig())
    visibleForScope = (toolName, scope) => !(toolName === 'aishell__sandbox_create' && scope !== undefined)

    // The unscoped answer stays yes — the global registration is still there —
    // but this agent cannot call the tool, so the guidance stays silent.
    expect(sections[0]?.text({ scope: { agent: 'restricted' } })).toBe('')
    expect(sections[0]?.text({ scope: undefined })).toBe(SANDBOX_GUIDANCE)
  })
})

describe('aishell-e2b — the manifest', () => {
  it('names the plugin and requires only the tool registry', async () => {
    const module = await import('../src/index.ts')
    expect(name).toBe('aishell-e2b')
    // The filesystem and the prompt are optional and taken lazily, so a
    // deployment without either still gets the sandbox tools.
    expect(module.inject).toEqual(['tools'])
  })
})
describe('aishell-e2b — credential changes', () => {
  it('subscribes to the credentials-updated event', () => {
    // The key is bound to the AK that minted it, but that check only runs on
    // the next sandbox call. Between a clear and that call the key still works
    // at the gateway, which is the opposite of what clearing means.
    apply(makeCtx() as never, makeConfig())

    expect(listeners.get('aishell/credentials-updated')).toHaveLength(1)
  })

})
