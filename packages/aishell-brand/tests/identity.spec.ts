/**
 * The identity section's registration contract.
 *
 * Four properties, mirroring the documentation pointer's spec one directory
 * over, with one inversion: this section's whole point is placement, so the
 * placement claim is the first thing pinned, not a footnote.
 *
 *   1. It registers first — in the harness identity's own slot, ahead of the
 *      deployment persona prefix and every policy — so the model reads who it
 *      is before anything it is asked to reason about.
 *   2. It takes the system prompt through `ctx.inject`, not as a declared
 *      service, so a deployment with no system prompt loses the section
 *      rather than failing to activate. The browser half of this package
 *      must keep mounting regardless: the brand slots are the product's face
 *      and the identity is only what the model reads.
 *   3. Interpolation is switched off. The text is prose, and `renderPrompt`
 *      scans a section for `{{variable}}` references by default — a text
 *      carrying a `{{` it cannot resolve makes assembly throw inside the
 *      agent step, where nothing catches it. The test drives the real
 *      renderer to prove the scan is off, because asserting the flag alone
 *      would pass on a text that merely happens to contain no braces.
 *   4. The text is the AI Shell self-introduction, and it keeps exactly one
 *      "DeepSeek Harness" — the whole point of the section is to be the one
 *      place the model reads that name.
 */

import { describe, it, expect } from 'vitest'
import { renderPrompt } from '@deepseek-ai/dsh-system-prompt'

const { apply, IDENTITY_PROMPT, IDENTITY_SECTION_NAME } = await import('../src/index.ts')

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
            // The slot resolution the real service owns: HARNESS_IDENTITY is
            // the opener's slot, the first thing in the assembled prompt.
            getSectionOrder: () => -1000,
          },
        })
      }
    },
  }
  return { ctx: ctx as never, sections, injectedDeps }
}

describe('aishell-brand — the identity section', () => {
  it('takes the system prompt through ctx.inject, not as a required service', async () => {
    const { ctx, injectedDeps } = makeCtx()
    apply(ctx)

    expect(injectedDeps).toEqual([['systemPrompt']])
    // A required service would make the whole entry fail to activate where the
    // system prompt is absent — and take the browser half's brand slots down
    // with it, since one loader entry mounts both halves; injecting it does not.
    const mod = await import('../src/index.ts')
    expect(mod.inject).toEqual([])
  })

  it('registers exactly one section', () => {
    const { ctx, sections } = makeCtx()
    apply(ctx)

    expect(sections).toHaveLength(1)
    expect(sections[0]?.name).toBe(IDENTITY_SECTION_NAME)
    // Not spelled as a number: the order is read from the service so the
    // section keeps the opener's slot if the framework ever moves it.
    expect(sections[0]?.order).toBe(-1000)
  })

  it('takes the harness identity slot, not merely a negative number', async () => {
    // The placement claim, measured against the real service rather than the
    // stub: the slot the fixed `harness:identity` opener registers under is
    // the one this section must occupy. Mount the framework's own
    // SystemPrompt, register through the real code path, and read the order
    // back out.
    const { SystemPrompt } = await import('@deepseek-ai/dsh-system-prompt')
    const cordis = await import('@deepseek-ai/cordis')

    const app = new cordis.Context()
    await app.plugin(SystemPrompt, { includeHarnessIdentity: false, personaPrefix: 'PERSONA', personaSuffix: 'SUFFIX' })
    app.systemPrompt.section({ name: 'probe:plan-policy', order: 500, text: 'PLAN' })

    await app.plugin({ name: 'probe-identity', apply, inject: [] })

    const assembly = await app.systemPrompt.assemble({
      signal: new AbortController().signal,
    })
    const names = assembly.sections.map(section => section.name).filter(name => name.length > 0)

    const identity = names.indexOf(IDENTITY_SECTION_NAME)
    expect(identity).toBeGreaterThan(-1)
    // First: ahead of the persona prefix, the policies, and the fixed opener's
    // own slot — everything the assembled prompt says after this is said to a
    // model that already knows what it is.
    expect(identity).toBe(0)
    expect(names.indexOf('deployment:persona-prefix')).toBeGreaterThan(identity)
    expect(names.indexOf('probe:plan-policy')).toBeGreaterThan(identity)
    // And inside the persona envelope: the suffix still closes the prompt.
    expect(names.indexOf('deployment:persona-suffix')).toBeGreaterThan(identity)
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
    expect(section?.text).toBe(IDENTITY_PROMPT)

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
    expect(rendered).toBe(IDENTITY_PROMPT)
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
    const braceText = `${IDENTITY_PROMPT}\n\nSet it in ${'{{'}config}} as an example.`
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

  it('is the one place the model reads "DeepSeek Harness"', () => {
    // The convergence this section exists for: the name appears exactly once,
    // stated as what powers the assistant rather than what the assistant is.
    // The copy is the team-agreed one (2026-11-03): who the assistant is, its
    // strength, what powers it, and that it can be extended — nothing else.
    expect(IDENTITY_PROMPT).toBe(`You are AI Shell, an assistant that genuinely gets the user's work done, with particular strength in deploying and operating Huawei Cloud resources. You are powered by DeepSeek Harness (DSH), and the user can extend your abilities by installing DSH-compatible plugins.`)
  })
})
