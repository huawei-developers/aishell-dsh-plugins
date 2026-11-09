/**
 * aishell LLM gateway adapter plugin.
 *
 * Registers the `aishell` provider route on `ctx.llm`, routing model calls
 * through the aishell gateway. Every request is signed directly with the
 * user's AK/SK (SDK-HMAC-SHA256), read from the credential store (OS keyring
 * with memory fallback) via `createCredentialsStore` — there is no API-key
 * exchange between the credential and the call.
 *
 * Credential management (settings namespace + watch → store transfer) lives
 * in `aishell-credentials`; this plugin only consumes the stored credentials.
 *
 * This plugin also declares the `aishell` route in the configurable-provider
 * directory (`registerConfigurableProviders`), which is what the Models page
 * joins with live routes — and it carries a Config schema, without which the
 * settings mirror (and therefore the Models row) never lists this namespace.
 * The row has no card of its own: the browser half paints a status dot beside
 * the row's name and hides the Edit button, which has nothing to edit (see
 * `client/provider-row-shadow.ts`).
 *
 * @module @huaweidevtools/aishell-dsh-llm
 */

import type { Context, Volatile } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
// Type-only: pulls the Fiber.entry merge (the Loader row whose id is this
// entry's settings namespace).
import type {} from '@deepseek-ai/cordis-plugin-loader'
// Type-only: pulls the ctx.attachments merge. The adapter reads image request
// versions through that service, which is resolved per request rather than
// injected, so this import exists for the merge alone.
import type {} from '@deepseek-ai/dsh-attachment'
// Type-only: pulls the ctx.fs merge, so `ctx.get('fs')` below typechecks
// against the provider's real surface instead of silently widening to `any`.
import type {} from '@deepseek-ai/dsh-fs'
import { createCredentialsStore } from '@huaweidevtools/aishell-dsh-credentials-store'
import { GatewayAdapter } from './adapter.ts'
import { PROVIDER_DISPLAY_NAME } from './provider-name.ts'

export type { GatewayAdapter, GatewayAdapterOptions } from './adapter.ts'

/** Default chat API base URL. Both `/chat/completions` and `/models` hang below `/v1`. */
const DEFAULT_BASE_URL = 'https://openai.aishell.openbuildlab.com/v1'

/**
 * Default total-pixel cap one request image is scaled into, and the encoded
 * byte target the encoder aims for. Both match the pi-ai defaults, for the
 * same reason: the gateway publishes no image budget, so the route needs a
 * bound that keeps one large upload from dominating a request.
 */
const DEFAULT_REQUEST_IMAGE_PIXEL_BUDGET = 4_194_304
const DEFAULT_REQUEST_IMAGE_MAX_BYTES = 1_048_576

/**
 * Default accumulated base64 bytes one request may carry before its oldest
 * images must be offloaded. Above this the request fails with
 * `IMAGE_OFFLOAD_REQUIRED` and `dsh-compaction-image-offload` (mounted by
 * `dsh-base`) replaces the oldest occurrences with placeholders. Again the
 * pi-ai default.
 */
const DEFAULT_MAX_REQUEST_IMAGE_BYTES = 20_971_520

/** Plugin config. */
export interface Config {
  /** Chat API base URL. Default: the public aishell gateway. */
  readonly baseUrl: Volatile<string>
  /** Total-pixel cap one request image is projected into. */
  readonly requestImagePixelBudget: Volatile<number>
  /** Encoded-byte target for one request image. */
  readonly requestImageMaxBytes: Volatile<number>
  /** Accumulated base64 image bytes one request accepts before offload is required. */
  readonly maxRequestImageBytes: Volatile<number>
}

/**
 * Settings schema for this entry.
 *
 * The schema exists for two reasons beyond configurability: the settings
 * mirror only lists namespaces whose plugin declares a Config, and the Models
 * page derives a provider row's existence from that listing — without a
 * schema, the `aishell` route registers its adapter but never shows up as a
 * configurable provider.
 */
export const Config = z.object({
  baseUrl: z.string().default(DEFAULT_BASE_URL).volatile(),
  requestImagePixelBudget: z.number().step(1).min(1).default(DEFAULT_REQUEST_IMAGE_PIXEL_BUDGET).volatile(),
  requestImageMaxBytes: z.number().step(1).min(1).default(DEFAULT_REQUEST_IMAGE_MAX_BYTES).volatile(),
  maxRequestImageBytes: z.number().step(1).min(1).default(DEFAULT_MAX_REQUEST_IMAGE_BYTES).volatile(),
})

export const name = 'aishell-llm'
export const inject = ['llm']

/** The provider route this plugin owns. */
export const PROVIDER = 'aishell'

export { PROVIDER_DISPLAY_NAME } from './provider-name.ts'

export function apply(ctx: Context, config: Config): void {
  const store = createCredentialsStore()
  // Every value below is read through a thunk, not captured: this Config is
  // entirely Volatile, so an edit is a volatile-only loader update that commits
  // into the same references and returns without re-running apply()
  // (cordis-plugin-loader/lib/index.js:381-388). The adapter instance therefore
  // outlives the values it was constructed with, and a snapshot would leave the
  // settings surface and the wire disagreeing until the next restart.
  const adapter = new GatewayAdapter({
    resolveBaseUrl: () => config.baseUrl.get(),
    keyring: store,
    // Resolved per request, not captured: `attachments` is provided by a
    // sibling plugin whose fiber may mount after this one, and
    // `dsh-attachment-local` is the ordinary provider of it.
    resolveAttachments: () => ctx.get('attachments'),
    resolveHostPath: hostPath => ctx.get('fs')?.processPathFromHostPath(hostPath),
    resolveImageBudget: () => ({
      maxPixels: config.requestImagePixelBudget.get(),
      maxBytes: config.requestImageMaxBytes.get(),
    }),
    resolveMaxRequestImageBytes: () => config.maxRequestImageBytes.get(),
  })
  ctx.llm.registerAdapter([PROVIDER], adapter)
  // The configurable-provider directory is what the Models page joins with the
  // live routes: without this entry the page has no row for the route and no
  // settings address to edit it at. `settingsPath: []` marks the whole section
  // as the profile, the same shape `llm-deepseek-api-key` uses. No `apiKeyEnv`
  // field means the row asks for no key — credentials live in our own store,
  // managed by `aishell-credentials`, so the row answers "usable" on its live
  // adapter alone.
  ctx.llm.registerConfigurableProviders([
    {
      provider: PROVIDER,
      displayName: PROVIDER_DISPLAY_NAME,
      settingsNs: ctx.fiber.entry?.options.id ?? name,
      settingsPath: [],
    },
  ])
}
