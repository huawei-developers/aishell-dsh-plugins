/**
 * Node-half entry for the AI Shell handbook plugin.
 *
 * One prompt section, no tools, no browser half. The section is what the model
 * reads to answer questions about the product itself — where feedback goes,
 * what the read-only switch does, how abilities are added — as opposed to what
 * it can do, which the tool packages state.
 *
 * @module @huaweidevtools/aishell-dsh-handbook
 */

import type { Context } from '@deepseek-ai/cordis'
import { registerHandbook } from './prompt.ts'

export { HANDBOOK, HANDBOOK_ORDER, HANDBOOK_SECTION_NAME } from './prompt.ts'

export const name = 'aishell-handbook'

/**
 * No required services.
 *
 * The one dependency is taken through `ctx.inject` inside
 * {@link registerHandbook}, so a deployment without a system prompt loses the
 * handbook instead of the whole entry failing to activate.
 */
export const inject: readonly string[] = []

export function apply(ctx: Context): void {
  registerHandbook(ctx)
}