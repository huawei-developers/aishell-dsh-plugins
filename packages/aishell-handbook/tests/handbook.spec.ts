/**
 * The handbook's registration contract, and the properties of its text that are
 * easy to lose in an edit.
 *
 * The placement and registration checks mirror the documentation pointer's
 * spec one package over. The text checks are this package's own:
 *
 *   1. The section is a list of topics, not an essay with a count in its
 *      opening line. Adding a topic must be an append, so nothing in the text
 *      may assert how many topics there are.
 *   2. Every UI location the text names is one the shell really has, and the
 *      permission chip's two positions are both given. A made-up menu item, or
 *      a landmark that is only true on half the screens, is the failure mode
 *      this section exists to prevent.
 */

import { describe, it, expect } from 'vitest'
import { renderPrompt } from '@deepseek-ai/dsh-system-prompt'

const { apply, HANDBOOK, HANDBOOK_SECTION_NAME, HANDBOOK_ORDER } = await import('../src/index.ts')

/** One registered section, as the stubbed service received it. */
interface RegisteredSection {
  name: string
  order: number
  text: string | ((context: unknown) => string)
  interpolate?: boolean
}

/** Build a ctx whose systemPrompt records what gets registered. */
function makeCtx(options: { systemPrompt?: boolean } = {}): {
  ctx: never
  sections: RegisteredSection[]
  injectedDeps: string[][]
} {
  const sections: RegisteredSection[] = []
  const injectedDeps: string[][] = []
  const ctx = {
    inject: (deps: string[], fn: (scope: unknown) => void) => {
      injectedDeps.push([...deps])
      // This stub models the absent case below rather than reproducing the
      // framework's: the real `ctx.inject` calls back once the dependency is
      // available and not before. What the test can hold is this package's own
      // half — that it asks through `inject` and registers nothing when the
      // callback never comes.
      if (options.systemPrompt !== false) {
        fn({
          systemPrompt: {
            section: (section: RegisteredSection) => {
              sections.push(section)
              return () => {}
            },
          },
        })
      }
    },
  }
  return { ctx: ctx as never, sections, injectedDeps }
}

describe('aishell-handbook — registration', () => {
  it('takes the system prompt through ctx.inject, not as a required service', async () => {
    const { ctx, injectedDeps } = makeCtx()
    apply(ctx)

    expect(injectedDeps).toEqual([['systemPrompt']])
    // A required service would make the whole entry fail to activate where the
    // system prompt is absent; injecting it does not.
    const mod = await import('../src/index.ts')
    expect(mod.inject).toEqual([])
  })

  it('registers exactly one section', () => {
    const { ctx, sections } = makeCtx()
    apply(ctx)

    expect(sections).toHaveLength(1)
    expect(sections[0]?.name).toBe(HANDBOOK_SECTION_NAME)
    expect(sections[0]?.order).toBe(HANDBOOK_ORDER)
  })

  it('places the handbook after the docs pointer and before the first policy', () => {
    // The framework's table: DEPLOYMENT_PERSONA_PREFIX 0, PLAN_POLICY 500.
    // The docs pointer sits at 100, and these two are one band: read where to
    // look things up, then how the product behaves, then what to reason about.
    expect(HANDBOOK_ORDER).toBeGreaterThan(100)
    expect(HANDBOOK_ORDER).toBeLessThan(500)
  })

  it('lands after the persona and before the policy slots in a real assembly', async () => {
    // The ordering claim, measured rather than asserted: mount the plugin
    // against the framework's own SystemPrompt service and read the order out.
    const { SystemPrompt } = await import('@deepseek-ai/dsh-system-prompt')
    const cordis = await import('@deepseek-ai/cordis')

    const app = new cordis.Context()
    await app.plugin(SystemPrompt, { personaPrefix: 'PERSONA', personaSuffix: 'SUFFIX' })
    app.systemPrompt.section({ name: 'probe:docs', order: 100, text: 'DOCS' })
    app.systemPrompt.section({ name: 'probe:plan-policy', order: 500, text: 'PLAN' })
    app.systemPrompt.section({ name: 'probe:tool-bash', order: 1000, text: 'BASH' })

    await app.plugin({ name: 'probe-handbook', apply, inject: [] })

    const assembly = await app.systemPrompt.assemble({
      signal: new AbortController().signal,
    })
    const names = assembly.sections.map(section => section.name).filter(name => name.length > 0)

    const handbook = names.indexOf(HANDBOOK_SECTION_NAME)
    expect(handbook).toBeGreaterThan(-1)
    expect(handbook).toBeGreaterThan(names.indexOf('deployment:persona-prefix'))
    // After the docs pointer, before the first policy and every tool slot.
    expect(handbook).toBeGreaterThan(names.indexOf('probe:docs'))
    expect(handbook).toBeLessThan(names.indexOf('probe:plan-policy'))
    expect(handbook).toBeLessThan(names.indexOf('probe:tool-bash'))
    // Inside the persona envelope: the suffix closes the prompt.
    expect(handbook).toBeLessThan(names.indexOf('deployment:persona-suffix'))
  })

  it('contributes no section when the system prompt is absent', () => {
    const { ctx, sections, injectedDeps } = makeCtx({ systemPrompt: false })
    expect(() => { apply(ctx) }).not.toThrow()

    expect(injectedDeps).toEqual([['systemPrompt']])
    expect(sections).toHaveLength(0)
  })

  it('registers its text verbatim through the real renderer', () => {
    const { ctx, sections } = makeCtx()
    apply(ctx)

    const section = sections[0]
    expect(section?.text).toBe(HANDBOOK)

    // Drive `renderPrompt`, not a hand-rolled join: the point is that the
    // framework hands the model this exact text.
    const rendered = renderPrompt({
      sections: [
        {
          name: section?.name ?? '',
          text: section?.text as string,
          ...(section?.interpolate === undefined ? {} : { interpolate: section.interpolate }),
        },
      ],
      contexts: [],
      tools: [],
      variables: {},
    })
    expect(rendered).toBe(HANDBOOK)
  })

  it('survives a brace in the text, because the scan is off', () => {
    // The failure this guards: `interpolate` defaults to true, and a `{{` the
    // renderer cannot resolve throws at assembly — inside the agent step, with
    // no catch above it, so one stray brace ends the turn.
    const { ctx, sections } = makeCtx()
    apply(ctx)
    const section = sections[0]
    expect(section?.interpolate).toBe(false)

    const braceText = `${HANDBOOK}\n\nSet it in ${'{{'}config}} as an example.`
    expect(() => renderPrompt({
      sections: [{ name: section?.name ?? '', text: braceText, interpolate: section?.interpolate ?? true }],
      contexts: [],
      tools: [],
      variables: {},
    })).not.toThrow()
  })
})

describe('aishell-handbook — the text', () => {
  it('does not count its own topics', () => {
    // The failure this guards: an opening line like "AI Shell has two
    // behaviours worth explaining" makes adding a third behaviour an edit to
    // the sentence that introduces all of them, rather than an append. Every
    // topic is a heading, so the text is free to grow.
    expect(HANDBOOK).not.toMatch(/\b(two|three|four|five) (behaviours|topics|things)\b/i)
    // And the shape that makes growth an append: one heading per topic.
    expect(HANDBOOK.match(/^## /gm)?.length ?? 0).toBeGreaterThanOrEqual(3)
  })

  it('names the feedback entry points the shell actually renders', () => {
    // Pinned to the strings the shell ships — `dsh-client-ui-commands` carries
    // the `/feedback` label, `dsh-session-log-export` the ⋯ menu, and
    // `dsh-client-ui-message-feedback` the per-message pair. A made-up entry
    // point is the exact failure this section exists to prevent.
    expect(HANDBOOK).toContain('/feedback')
    expect(HANDBOOK).toContain('More actions')
    expect(HANDBOOK).toContain('更多操作')
    expect(HANDBOOK).toMatch(/Like \/ Dislike/)
  })

  it('distinguishes the session-wide entry point from the per-message one', () => {
    // Both open the same dialog, so an explanation that does not say which is
    // which sends the user to the wrong control.
    expect(HANDBOOK).toMatch(/whole session/)
    expect(HANDBOOK).toMatch(/one message/)
  })

  it('names both permission modes and where the switch lives', () => {
    expect(HANDBOOK).toContain('Read-only')
    expect(HANDBOOK).toContain('Read-write')
    expect(HANDBOOK).toContain('只读')
    expect(HANDBOOK).toContain('读写')
    expect(HANDBOOK).toMatch(/chip/)
  })

  it('gives both places the permission chip appears', () => {
    // The chip is not in one fixed spot: `AishellAccountHint` mounts into
    // `conversation.composer.dock` (under the input bar, once a session
    // exists) and `AishellHeroChip` into `conversation.input.dock` (the band
    // above it, on a blank session). A user told only "beside the input box"
    // looks in the wrong one of the two on half their screens, which is the
    // complaint this paragraph exists to prevent.
    expect(HANDBOOK).toMatch(/under the input box/)
    expect(HANDBOOK).toMatch(/above the input box/)
    // And the landmark that survives both: it sits beside the account chip,
    // which carries the Huawei mark.
    expect(HANDBOOK).toMatch(/Huawei logo/)
  })

  it('does not send the user to a settings page that does not exist', () => {
    // The mode is out-of-band state with a single control, not a settings
    // surface. Naming a "permission settings page" is a dead end.
    expect(HANDBOOK).toMatch(/no "permission settings" page/i)
  })

  it('says a flip takes effect immediately', () => {
    // The host route writes the module state the gate reads on the next call
    // (`setMode` in `aishell-deploy`), so there is no restart and nothing to
    // reconnect. The wording says so rather than leaving it implicit.
    expect(HANDBOOK).toMatch(/takes effect immediately/)
  })

  it('tells the model not to transcribe the section into a reply', () => {
    // The section is background. A model that pastes its structure into an
    // answer gives the user a manual instead of the one line they needed, and
    // discloses the shape of the prompt to them.
    expect(HANDBOOK).toMatch(/Do not paste or paraphrase/)
  })
})