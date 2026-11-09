/**
 * Build config for the aishell LLM plugin (host + client halves).
 *
 * 1. lib/index.js + lib/types/ — Node half (host plugin: adapter registration,
 *    configurable-provider directory, models-catalog route).
 * 2. lib/client.js — Browser half (the Models page's provider-card seat),
 *    built through the shared closure-factory preset with platform modules as
 *    externals resolved by the shell's module table.
 */
import { clientBundle } from '../../shared/tsdown.client.ts'

export default clientBundle('@huaweidevtools/aishell-dsh-llm', ['src/index.ts'])
