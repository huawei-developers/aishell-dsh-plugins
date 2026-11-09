/**
 * The read-only policy, as guidance the model reads before it acts.
 *
 * ## Why a runtime context and not a prompt section
 *
 * `systemPrompt.context()` materializes as a separate history message and is
 * committed only when its text changes. `systemPrompt.section()` would edit the
 * system prompt itself, so flipping the switch would invalidate the cache from
 * the first token on every turn. The mode is stable for most turns, so the
 * context costs one short message when it changes and nothing afterwards.
 *
 * The order is the approval policy's, because this is the same kind of fact: an
 * out-of-band decision the model must work under rather than one it made.
 *
 * ## What this text is, and is not
 *
 * The mode is enforced by this plugin's own gate: it refuses cloud
 * mutations at the tool and HTTP layers, and it names the specific operation
 * and what remains available when it does. That gate is the guarantee — a
 * refusal cannot be talked around.
 *
 * This text therefore does not restate the gate's rules. It covers what the
 * gate cannot: the way of working. A read-only session is a review session, and
 * the model should carry the work through rather than decline it. The
 * over-refusal it guards against is the default failure of a prompt-side
 * constraint: a model that reads "read-only" as "I may not touch anything",
 * stops early, and leaves the user with less than they asked for.
 *
 * ## The gap this text cannot close
 *
 * The gate covers the paths this plugin owns — its tools and the signed
 * HTTP requests they make. A cloud resource reachable another way (an
 * EIP, a tunnel, an internal address) is the same account over a route no
 * permission check here sees, and nothing in this plugin can intercept a local
 * shell command to stop it. So the reachable-route paragraph is the only
 * constraint on that path, and it is an instruction rather than an enforcement.
 * Closing it for real is a network-layer decision — leaving the resource
 * unreachable — not something a plugin can do.
 *
 * @module @huaweidevtools/aishell-dsh-deploy/permission-context
 */

import type { Context } from '@deepseek-ai/cordis'
// Type-only: pulls the ctx.systemPrompt merge and the context-order names.
import type {} from '@deepseek-ai/dsh-system-prompt'
import type { PermissionMode } from './permission.ts'

/** Name this contribution registers under; unique across the assembled prompt. */
export const PERMISSION_CONTEXT_NAME = 'aishell:permission-policy'

/**
 * What the model reads while mutations are refused.
 *
 * Three paragraphs, each doing one job: the state and its scope, the route
 * the gate does not cover, and the way of working that keeps a read-only
 * session useful.
 */
export const READ_ONLY_POLICY = `Current HuaweiCloud permission mode: read-only — nothing in the HuaweiCloud account is to change, by any route, including resources reachable directly.

An EIP, a tunnel, or an internal address that answers is still the same account. Reads over such a path are fine; state changes are not. Reaching a resource by a route the permission check does not cover does not make the change allowed — do not use one to do what a refusal declined.

Local work is unaffected: files and local processes are yours. Treat the session as review work — carry the investigation through and produce the complete change (plan, exact commands, cost or impact), stating what would be applied. Ask for read-write only when a specific operation is blocked.`

/**
 * The text this context contributes for one mode.
 *
 * Read-write contributes nothing, and that is the whole point: `''` drops the
 * contribution from the snapshot, so there is no "you may now write" line to
 * go stale. Only read-only needs saying.
 *
 * An unknown mode contributes nothing either. Before the first read lands the
 * mode is genuinely unknown, and announcing read-only then would state a
 * restriction that may not hold — while the gate, if it is in fact read-only,
 * refuses precisely anyway.
 *
 * @param mode - the mode now in effect, or `undefined` before one is read.
 * @returns the policy text, or `''` to contribute nothing.
 */
export function permissionPolicyText(mode: PermissionMode | undefined): string {
  return mode === 'read_only' ? READ_ONLY_POLICY : ''
}

/**
 * Register the policy context, reading the mode through `current` at each
 * assembly.
 *
 * Deferred behind `ctx.inject` rather than declared in this plugin's own
 * `inject`: the policy is an enhancement, and a deployment without the system
 * prompt should not lose the tools over it. `current` is a function because the
 * context provider is synchronous and evaluated per assembly, so the mode is
 * read from the module state at that moment rather than captured once.
 *
 * @param ctx - host context.
 * @param current - the mode last read or applied, or `undefined` if not yet read.
 */
export function registerPermissionPolicyContext(
  ctx: Context,
  current: () => PermissionMode | undefined,
): void {
  ctx.inject(['systemPrompt'], (scope) => {
    scope.systemPrompt.context({
      name: PERMISSION_CONTEXT_NAME,
      // Same order as the approval policy: both are out-of-band decisions the
      // model works under. Reusing it keeps this beside its kin in the snapshot
      // instead of at the end, where it would read as an afterthought.
      order: scope.systemPrompt.getContextOrder('APPROVAL_POLICY'),
      text: () => permissionPolicyText(current()),
    })
  })
}
