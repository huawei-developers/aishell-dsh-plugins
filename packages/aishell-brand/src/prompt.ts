/**
 * What the model reads about what it is.
 *
 * ## Why this is its own module
 *
 * The text and the mechanism that delivers it belong together, the same way
 * every other prompt contribution in this repo keeps them. Split across
 * `index.ts` — the string one place, the `systemPrompt.section()` call another
 * — the only way to see what the model actually reads is to read both. Here
 * they sit side by side, and `apply()` just calls
 * {@link registerIdentityPrompt}.
 *
 * ## Why the brand plugin owns the model's self-introduction
 *
 * The plugin already owns the half of branding a person sees — the sidebar
 * mark, the window title, the favicon. The self-introduction the model reads
 * is the other half of the same concern: what the product calls itself. A
 * deployment that rebrands the shell for its users and leaves the model
 * introducing itself as the un-rebranded harness splits one identity across
 * two owners, and the two drift independently.
 *
 * ## Why the order is the harness identity's own slot
 *
 * The text replaces an opener, so it takes the opener's place:
 * `getSectionOrder('HARNESS_IDENTITY')`, the same number the fixed
 * `harness:identity` section registers under, which sorts before everything
 * else in the assembled prompt. A deployment that turns the fixed opener off
 * (`includeHarnessIdentity: false`) is the one this section stands in for —
 * the profile change itself is the deployment's to make, not this plugin's;
 * a deployment that leaves the fixed opener on renders both, and the name
 * (`aishell:identity`, not `harness:identity`) keeps the pair two sections
 * rather than one shadowing the other.
 *
 * ## What the text does not say
 *
 * It does not describe the tools or the deployment flow: the plugins that own
 * those also state the approvals each step needs. This is the introduction,
 * not the manual.
 *
 * @module @huaweidevtools/aishell-dsh-brand/prompt
 */

import type { Context } from '@deepseek-ai/cordis'
// Type-only and seemingly empty, but load-bearing: the declaration merge that
// puts `systemPrompt` on `Context` lives in this module, and TypeScript only
// applies a merge it was made to read. Drop this import and `scope.systemPrompt`
// below stops compiling.
import type {} from '@deepseek-ai/dsh-system-prompt'

/** Name this contribution registers under; unique across the assembled prompt. */
export const IDENTITY_SECTION_NAME = 'aishell:identity'

/**
 * What the model reads about what it is.
 *
 * The team-agreed copy (2026-11-03): the identity says four things — who the
 * assistant is, its strength (deploying and operating Huawei Cloud resources),
 * what powers it, and that it can be extended. Mechanism and promise detail —
 * approval flows, read-only mode, where credentials live — are each owner
 * plugin's own section to state; the identity does not speak for them.
 *
 * English like every other host-side prompt text in this repo — the section
 * is host text, not UI copy, and the model answers in the user's language
 * regardless of the language it is instructed in.
 */
export const IDENTITY_PROMPT = `You are AI Shell, an assistant that genuinely gets the user's work done, with particular strength in deploying and operating Huawei Cloud resources. You are powered by DeepSeek Harness (DSH), and the user can extend your abilities by installing DSH-compatible plugins.`

/**
 * Register the identity section.
 *
 * Deferred behind `ctx.inject` rather than declared in this plugin's own
 * `inject`: the section is an enhancement, and a deployment without a system
 * prompt should lose it rather than fail to mount.
 *
 * @param ctx - host context.
 */
export function registerIdentityPrompt(ctx: Context): void {
  ctx.inject(['systemPrompt'], (scope) => {
    scope.systemPrompt.section({
      name: IDENTITY_SECTION_NAME,
      // The harness identity's own slot, resolved by name rather than spelled
      // as a number: the slot is the framework's to allocate, and reading it
      // keeps this section in the opener's place if the number ever moves.
      order: scope.systemPrompt.getSectionOrder('HARNESS_IDENTITY'),
      // Prose, not a template. `renderPrompt` interpolates a section's text by
      // default, and a text carrying a `{{` that is not a known variable makes
      // assembly throw — inside the agent step, where nothing catches it and
      // the turn dies. Nothing in this text is a variable, so the scan is
      // switched off rather than left to luck.
      interpolate: false,
      text: IDENTITY_PROMPT,
    })
  })
}
