/**
 * Huawei Cloud product-documentation pointer for DSH.
 *
 * ## What this injects, and why it is only a pointer
 *
 * One fact: where to read Huawei Cloud's product documentation. The index at
 * `llms.txt` is ~35 KB of product names — real value, but a per-turn cost of
 * roughly 9k tokens, of which a given task needs one entry. So the plugin
 * carries the pointer and lets the model fetch the index (and then the one
 * product under it) with the web-fetch tool it already has. That is the shape
 * `llms.txt` is designed for.
 *
 * ## Why a prompt section and not a runtime context
 *
 * The URL never changes, so this is static knowledge rather than session state.
 * `systemPrompt.section()` is the registration for text that is always present;
 * `context()` is for facts that flip (the read-only policy uses it for that
 * reason — it appears and disappears with the mode). A section is re-rendered
 * on every assembly either way; the difference is that a context snapshot is
 * only committed when its text changes.
 *
 * ## Where it sits in the prompt
 *
 * Early: immediately after the deployment persona prefix, ahead of every policy
 * and tool section. Background knowledge belongs before the model starts
 * planning — it should know where to look things up, not discover it once it has
 * reached the tool list.
 *
 * Measured against the real `SystemPrompt` service, the assembled prompt reads
 * `harness:identity`, the persona prefix, this section, then the policy and
 * tool slots, then the persona suffix.
 *
 * @module @huaweidevtools/aishell-dsh-huaweicloud-docs
 */

import type { Context } from '@deepseek-ai/cordis'
// Type-only and seemingly empty, but load-bearing: the declaration merge that
// puts `systemPrompt` on `Context` lives in this module, and TypeScript only
// applies a merge it was made to read. Drop this import and `scope.systemPrompt`
// below stops compiling.
import type {} from '@deepseek-ai/dsh-system-prompt'

/**
 * Position of the documentation pointer in the assembled prompt.
 *
 * A number rather than one of the framework's named slots, because its
 * placement table is closed: `PromptSectionOrderName` is `keyof` a fixed
 * constant, so `getSectionOrder('HUAWEICLOUD_DOCS')` returns `undefined` —
 * there is no slot for product-domain background.
 *
 * The table leaves the gap between the persona prefix (0) and the first policy
 * (500) empty, and 100 sits inside it. The two orders that bracket that gap are
 * the only two that exist: below 0 is before the persona opens, which is before
 * `harness:identity` at -1000 — ahead of the prompt having said what it is —
 * and at or above 500 is inside the policy band, where background reads as an
 * instruction. 100 puts this after the persona opens and before anything the
 * model is asked to reason about.
 */
export const HUAWEICLOUD_DOCS_ORDER = 100

/** Name this contribution registers under; unique across the assembled prompt. */
export const DOCS_SECTION_NAME = 'aishell:huaweicloud-docs'

/** The Huawei Cloud documentation index. */
export const DOCS_INDEX_URL = 'https://support.huaweicloud.com/llms.txt'

/**
 * What the model reads.
 *
 * The last sentence carries the weight: a model asked about a product's quotas
 * or billing answers from memory unless told not to, and those numbers move
 * between releases. Naming the authority is what makes the pointer worth
 * carrying.
 */
export const DOCS_POINTER = `Huawei Cloud product documentation — for what a product is, what it supports, its quotas and limits, or its billing model — is indexed at ${DOCS_INDEX_URL}

That index lists every Huawei Cloud product by category, each entry naming the product's own llms.txt. Read it to find the product, then read that product's file for the detail. Do not answer questions about a product's capabilities or limits from memory; they change between releases, and the documentation is the authority.`

/**
 * Register the documentation pointer.
 *
 * Deferred behind `ctx.inject` rather than declared in this plugin's own
 * `inject`: the pointer is an enhancement, and a deployment without the system
 * prompt should lose the pointer rather than fail to mount.
 *
 * @param ctx - host context.
 */
export function registerDocsPointer(ctx: Context): void {
  ctx.inject(['systemPrompt'], (scope) => {
    scope.systemPrompt.section({
      name: DOCS_SECTION_NAME,
      order: HUAWEICLOUD_DOCS_ORDER,
      // Prose and a URL, not a template. `renderPrompt` interpolates a
      // section's text by default, and a text carrying a `{{` that is not a
      // known variable makes assembly throw — inside the agent step, where
      // nothing catches it and the turn dies. Nothing in this text is a
      // variable, so the scan is switched off rather than left to luck.
      interpolate: false,
      text: DOCS_POINTER,
    })
  })
}

export const name = 'aishell-huaweicloud-docs'

/**
 * No required services.
 *
 * The one dependency is taken through `ctx.inject` inside
 * {@link registerDocsPointer}, so a deployment without a system prompt loses
 * the pointer instead of the whole entry failing to activate.
 */
export const inject: readonly string[] = []

export function apply(ctx: Context): void {
  registerDocsPointer(ctx)
}
