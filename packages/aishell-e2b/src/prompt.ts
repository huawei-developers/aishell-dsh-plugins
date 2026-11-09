/**
 * What the model reads about which tier to use.
 *
 * ## Why this is its own module
 *
 * The text and the mechanism that delivers it belong together. Split across
 * `index.ts` — the string one place, the `systemPrompt.section()` call another —
 * the only way to see what the model actually reads is to read both. Here they
 * sit side by side, and `apply()` just calls {@link registerSandboxGuidance}.
 *
 * ## Why the split is stated three ways
 *
 * The deciding property is lifecycle — does the result need to outlive the
 * task? — but that is one the model has to *infer* about work nobody has
 * described in those terms yet. Two more signals make the same question
 * answerable directly:
 *
 *   - **What the user asked for.** "A web page or a demo" versus "a production
 *     system" is a distinction a person can answer without knowing what a
 *     sandbox is.
 *   - **What the work needs.** The one capability a sandbox has that this
 *     machine does not is a public address. A request to deploy something and
 *     get a URL back is the strongest signal there is, and it is stated first
 *     because it is the least ambiguous.
 *
 * The three are kept together rather than reduced to one. They disagree at the
 * edges — a demo that must stay up, a production service that starts as a
 * sketch — and when they do, asking the user is the answer, which the text says.
 *
 * ## Why it says to ask
 *
 * A tie-break the model performs silently is a decision the user never sees
 * until the bill or the outage. So when the request does not make the tier
 * obvious, the model asks — and says what the choice costs, because "sandbox vs
 * Terraform" means nothing to someone who has not met either.
 *
 * ## What it does not say
 *
 * It does not describe the Terraform workflow. That belongs to the plugin that
 * owns those tools, which also states the approvals each step needs.
 *
 * @module @huaweidevtools/aishell-dsh-e2b/prompt
 */

import type { Context } from '@deepseek-ai/cordis'
// Type-only and seemingly empty, but load-bearing: the declaration merge that
// puts `systemPrompt` on `Context` lives in this module.
import type {} from '@deepseek-ai/dsh-system-prompt'

/** Position of the tier guidance in the assembled context. */
export const SANDBOX_PROMPT_ORDER = 110

/** Name this contribution registers under; unique across the assembled prompt. */
export const SANDBOX_SECTION_NAME = 'aishell:e2b'

/** What the model reads about which tier to use. */
export const SANDBOX_GUIDANCE = `A sandbox is a Linux environment running remotely. It exists for a bounded time, then is deleted along with everything in it. What it gives you that this machine does not is a public address.

That is the clearest signal: when the work has to be deployed somewhere reachable and the user wants a URL they can open — a web app, a demo, a service, a static page — use the sandbox tools (aishell__sandbox_*). Put the files there with aishell__sandbox_files_write, start the server with aishell__sandbox_commands_run and background: true, then call aishell__sandbox_get_port_url and give the user that address.

At the other end, a production system belongs in real infrastructure, deployed with the Terraform tools (aishell__terraform_* and their neighbours). It will cost money, it should keep running, and it will be operated. The sandbox is the wrong tier for it not because it is small but because it is deliberately short-lived — the address stops working when it expires.

So: a page or a demo, or anything that should end in a URL to open, is a sandbox. A system to run and keep running is Terraform.

If the request does not make clear which of these it is, ask the user before choosing. Say what the difference amounts to for them: a sandbox is throwaway and costs nothing to discard, while Terraform provisions real resources that are billed and meant to keep running. Follow what they pick.

A sandbox is often the right place to work something out before committing real resources to it.

This conversation works in at most one sandbox at a time. Create it with aishell__sandbox_create before the tools that use it, and choose its lifetime there — the value should match what the work needs, since the sandbox and its contents are deleted when it expires.

Never put sensitive material in a sandbox. aishell__sandbox_get_port_url makes what you serve publicly reachable by anyone who has the address, for as long as the sandbox lives — which is exactly what makes a sandbox useful, and exactly why it must not hold anything private. That covers credentials and keys of any kind, personal data, internal documents, and content that is unlawful to publish: political material and adult, gambling or drug-related content among it. A public URL cannot be unpublished: anyone who opened it, or copied what it served, keeps that copy after the sandbox is deleted.

If a request would require any of that, stop and say so rather than deploying it. Do not work around the rule by splitting the content, renaming files, or serving it from another port.`

/**
 * Register the guidance section.
 *
 * Deferred behind `ctx.inject` rather than declared in this plugin's own
 * `inject`: the guidance is an enhancement, and a deployment without a system
 * prompt should lose it rather than fail to mount.
 *
 * @param ctx - host context.
 */
export function registerSandboxGuidance(ctx: Context): void {
  ctx.inject(['systemPrompt'], (scope) => {
    scope.systemPrompt.section({
      name: SANDBOX_SECTION_NAME,
      order: SANDBOX_PROMPT_ORDER,
      // Prose, not a template: an unknown `{{` in a section's text makes
      // assembly throw inside the agent step, where nothing catches it.
      interpolate: false,
      // Silent when the tools are absent, which happens when another plugin has
      // restricted this agent's toolset: guidance for tools the model cannot
      // see would invite it to try them. The rendering scope is passed through
      // because a tool restricted away for *this* agent is exactly the case
      // this guard exists to catch — an unscoped lookup would still find the
      // global registration and announce it.
      text: ({ scope: renderScope }) =>
        ctx.tools.get('aishell__sandbox_create', renderScope) === undefined
          ? ''
          : SANDBOX_GUIDANCE,
    })
  })
}