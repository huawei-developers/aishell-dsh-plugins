/**
 * The documentation pointer's registration contract.
 *
 * Four properties, and the first three are about placement rather than prose:
 *
 *   1. It registers early — after the deployment persona, ahead of the first
 *      policy — so the model has the pointer before it plans, not after it has
 *      reached the tool list.
 *   2. It takes the system prompt through `ctx.inject`, not as a declared
 *      service, so a deployment with no system prompt loses the pointer rather
 *      than failing to activate.
 *   3. Interpolation is switched off. The text is prose and a URL, not a
 *      template, and `renderPrompt` scans a section for `{{variable}}`
 *      references by default — a text carrying a `{{` it cannot resolve makes
 *      assembly throw inside the agent step, where nothing catches it. The
 *      test drives the real renderer to prove the scan is off, because
 *      asserting the flag alone would pass on a text that merely happens to
 *      contain no braces.
 *   4. The URL is the Huawei Cloud documentation index, and the text says what
 *      it is for.
 */

import { describe, it, expect } from 'vitest'
import { renderPrompt } from '@deepseek-ai/dsh-system-prompt'

const { apply, DOCS_POINTER, DOCS_SECTION_NAME, DOCS_INDEX_URL, HUAWEICLOUD_DOCS_ORDER } =
  await import('../src/index.ts')

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
      // available and not before, and there is no cheap way to stand up the
      // real service here. What the test can hold is this package's own half —
      // that it asks through `inject` and registers nothing when the callback
      // never comes.
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

describe('aishell-huaweicloud-docs', () => {
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
    expect(sections[0]?.name).toBe(DOCS_SECTION_NAME)
    expect(sections[0]?.order).toBe(HUAWEICLOUD_DOCS_ORDER)
  })

  it('places the pointer before the first policy section', () => {
    // The framework's table: DEPLOYMENT_PERSONA_PREFIX 0, PLAN_POLICY 500.
    // Ahead of 500 is what makes this background rather than an afterthought.
    expect(HUAWEICLOUD_DOCS_ORDER).toBeGreaterThan(0)
    expect(HUAWEICLOUD_DOCS_ORDER).toBeLessThan(500)
  })

  it('lands after the persona and before the policy slots in a real assembly', async () => {
    // The ordering claim the docs make, measured rather than asserted: mount
    // the built plugin against the framework's own SystemPrompt service and
    // read the order back out. The unit test above pins two numbers; this one
    // pins the sentence those numbers are there to support.
    const { SystemPrompt } = await import('@deepseek-ai/dsh-system-prompt')
    const cordis = await import('@deepseek-ai/cordis')

    const app = new cordis.Context()
    await app.plugin(SystemPrompt, { personaPrefix: 'PERSONA', personaSuffix: 'SUFFIX' })
    app.systemPrompt.section({ name: 'probe:plan-policy', order: 500, text: 'PLAN' })
    app.systemPrompt.section({ name: 'probe:tool-bash', order: 1000, text: 'BASH' })

    const { apply: mount } = await import('../src/index.ts')
    await app.plugin({ name: 'probe-docs', apply: mount, inject: [] })

    const assembly = await app.systemPrompt.assemble({
      signal: new AbortController().signal,
    })
    const names = assembly.sections.map(section => section.name).filter(name => name.length > 0)

    const docs = names.indexOf(DOCS_SECTION_NAME)
    expect(docs).toBeGreaterThan(-1)
    // After the persona opens, before the first policy and every tool slot.
    expect(docs).toBeGreaterThan(names.indexOf('deployment:persona-prefix'))
    expect(docs).toBeLessThan(names.indexOf('probe:plan-policy'))
    expect(docs).toBeLessThan(names.indexOf('probe:tool-bash'))
    // And inside the persona envelope: the suffix closes the prompt.
    expect(docs).toBeLessThan(names.indexOf('deployment:persona-suffix'))
  })

  it('contributes no section when the system prompt is absent', () => {
    const { ctx, sections, injectedDeps } = makeCtx({ systemPrompt: false })
    expect(() => { apply(ctx) }).not.toThrow()

    // The dependency was still requested; nothing was registered.
    expect(injectedDeps).toEqual([['systemPrompt']])
    expect(sections).toHaveLength(0)
  })

  it('registers its text verbatim through the real renderer', () => {
    const { ctx, sections } = makeCtx()
    apply(ctx)

    const section = sections[0]
    expect(section?.text).toBe(DOCS_POINTER)
    expect(DOCS_POINTER).toContain(DOCS_INDEX_URL)

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
    expect(rendered).toBe(DOCS_POINTER)
  })

  it('survives a brace in the text, because the scan is off', () => {
    // The failure this guards: `interpolate` defaults to true, and a `{{` the
    // renderer cannot resolve throws at assembly — inside the agent step, with
    // no catch above it, so one stray brace ends the turn. Nothing in the
    // shipped text has a brace today; this proves the guarantee does not rest
    // on that staying true.
    const { ctx, sections } = makeCtx()
    apply(ctx)
    const section = sections[0]
    expect(section?.interpolate).toBe(false)

    // Two braces, which is what trips the scanner: `{{` with no resolvable
    // variable name. A lone brace would pass even with the scan on.
    const braceText = `${DOCS_POINTER}\n\nSet it in ${'{{'}config}} as an example.`
    expect(() => renderPrompt({
      sections: [{ name: section?.name ?? '', text: braceText, interpolate: section?.interpolate ?? true }],
      contexts: [],
      tools: [],
      variables: {},
    })).not.toThrow()

    // And the same text with the flag dropped is exactly the throw above.
    expect(() => renderPrompt({
      sections: [{ name: 'probe', text: braceText, interpolate: true }],
      contexts: [],
      tools: [],
      variables: {},
    })).toThrow(/prompt variable/)
  })

  it('names the documentation index and says what it is for', () => {
    expect(DOCS_INDEX_URL).toBe('https://support.huaweicloud.com/llms.txt')
    // The two-layer structure: the index leads to each product's own file.
    expect(DOCS_POINTER).toMatch(/product's own llms\.txt/i)
    // And the authority claim, which is what stops an answer from memory.
    expect(DOCS_POINTER).toMatch(/documentation is the authority/i)
  })
})
