/**
 * Node-half entry for the aishell brand plugin.
 *
 * The browser half (src/client/) owns what a person sees: the brand slots,
 * the window title, the favicon. This half owns what the model reads: one
 * system-prompt section introducing AI Shell (src/prompt.ts), registered in
 * the harness identity's slot so it stands in for the fixed DeepSeek Harness
 * opener in deployments that turn that opener off. The cordis loader needs
 * this entry anyway — mounting the package as a loader entry is what makes
 * its `dsh.client` declaration visible to the client-modules scanner and its
 * browser bundle (`lib/client.js`) discoverable at `/plugins/<id>/client.js`.
 *
 * @module @huaweidevtools/aishell-dsh-brand
 */

import type { Context } from '@deepseek-ai/cordis'
import { registerIdentityPrompt } from './prompt.ts'

export { IDENTITY_PROMPT, IDENTITY_SECTION_NAME } from './prompt.ts'

export const name = 'aishell-brand'
export const inject: readonly string[] = []

export function apply(ctx: Context): void {
  registerIdentityPrompt(ctx)
}
