/**
 * The E2B sandbox plugin: a second, disposable execution tier for DSH.
 *
 * ## What problem this solves
 *
 * Every deployment request currently reaches the same path — the Huawei Cloud
 * operations server, provisioning real resources with real cost, real
 * credentials, and real cleanup obligations. A large fraction of requests do
 * not need that: a static page, a small service, something to look at once.
 * Those need a place to run and an address to open, and nothing that outlives
 * the task.
 *
 * This plugin adds that tier. The model chooses between them, which is why it
 * also contributes a prompt section saying when each is appropriate: tools
 * alone would leave the choice to guesswork.
 *
 * ## What it is not
 *
 * It does not replace the harness's execution world. The official
 * `@deepseek-ai/dsh-e2b` package does that — it swaps `ctx.fs` and
 * `ctx.subprocess` so every file and command the agent touches runs remotely.
 * This plugin instead adds *tools*, so the agent keeps working locally and
 * reaches a sandbox only when it decides to. The two can be mounted together;
 * only the names look alike.
 *
 * ## How it reaches the service
 *
 * The key comes from the AI Shell provisioning service, signed with the
 * operator's stored Huawei Cloud credentials; the sandbox protocol itself is
 * spoken by the official `e2b` client library, pointed at the gateway's domain.
 * See `sandbox-key.ts` and `client.ts`.
 *
 * @module @huaweidevtools/aishell-dsh-e2b
 */

import type { Context, Volatile } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
// Type-only: pulls the `ctx.tools` registry merge.
import type {} from '@deepseek-ai/dsh-tools'
// Type-only: pulls the `ctx.fs` merge, for the download tool's destination.
import type {} from '@deepseek-ai/dsh-fs'
// Type-only: pulls the `ctx.systemPrompt` merge.
import type {} from '@deepseek-ai/dsh-system-prompt'

import { SandboxClient } from './client.ts'
import { openCredentialStore, readCredentials } from './credentials.ts'
import { SandboxKeySource } from './sandbox-key.ts'
import { SandboxRegistry } from './sandbox-registry.ts'
import { registerSandboxTools, type SessionDirectories } from './tools.ts'
import { registerSandboxGuidance } from './prompt.ts'

/** The provisioning service the API key is fetched from. */
const DEFAULT_API_BASE_URL = 'https://openapi.aishell.openbuildlab.com'

/** The sandbox gateway's domain — the value an E2B client calls `E2B_DOMAIN`. */
const DEFAULT_DOMAIN = 'aishell.openbuildlab.com'

/** Default per-request timeout for both the key fetch and SDK calls. */
const DEFAULT_REQUEST_TIMEOUT_MS = 60_000

/** Plugin config. */
export interface Config {
  /** Base URL of the sandbox key provisioning service. */
  readonly apiBaseUrl: Volatile<string>
  /** The sandbox gateway's domain, e.g. `aishell.openbuildlab.com`. */
  readonly domain: Volatile<string>
  /** Per-request timeout for the key fetch and for SDK control-plane calls. */
  readonly requestTimeoutMs: Volatile<number>
}

/**
 * Settings schema for this entry.
 *
 * Both URLs are Volatile: they are deployment facts that differ between a
 * staging and a production profile, and a change should apply to the next call
 * rather than requiring a restart.
 */
export const Config = z.object({
  apiBaseUrl: z.string().default(DEFAULT_API_BASE_URL).volatile(),
  domain: z.string().default(DEFAULT_DOMAIN).volatile(),
  requestTimeoutMs: z.number().step(1).min(1).default(DEFAULT_REQUEST_TIMEOUT_MS).volatile(),
})

export { SANDBOX_GUIDANCE, SANDBOX_PROMPT_ORDER, SANDBOX_SECTION_NAME } from './prompt.ts'

export const name = 'aishell-e2b'

/**
 * Required services: the tool registry alone.
 *
 * The filesystem and the system prompt are both optional and taken through
 * `ctx.inject` / `ctx.get` — a deployment without a filesystem loses one
 * tool's destination, and one without a system prompt loses the guidance
 * section, neither of which should stop the sandbox tools from registering.
 */
export const inject = ['tools']

export function apply(ctx: Context, config: Config): void {
  const store = openCredentialStore()

  // Every value is read through a thunk, not captured: this Config is entirely
  // Volatile, so an edit commits into the same references and returns without
  // re-running apply(). A snapshot would leave the settings surface and the
  // wire disagreeing until the next restart.
  const keys = new SandboxKeySource({
    baseUrl: config.apiBaseUrl.get(),
    readCredentials: () => readCredentials(store),
    // The key is a stored credential rather than process state, so a restart
    // reuses it instead of creating another — which would be a new tenant, and
    // would orphan every sandbox made under the old one.
    store,
    timeoutMs: config.requestTimeoutMs.get(),
  })

  const client = new SandboxClient({
    resolveDomain: () => config.domain.get(),
    keys,
    resolveRequestTimeoutMs: () => config.requestTimeoutMs.get(),
  })

  const registry = new SandboxRegistry(
    // Recovering a binding after a restart is a metadata query, so the
    // registry asks the gateway through the same client every tool uses.
    (metadata, signal) => client.findByMetadata(metadata, signal),
  )

  const disposers = registerSandboxTools(ctx, {
    client,
    registry,
    resolveFs: () => ctx.get('fs'),
    // Read at call time like `fs`, and optional like it: without this service a
    // relative `localPath` falls back to the backend's own default rather than
    // the tool refusing to write.
    //
    // One cast, at the single boundary that knows the concrete service. The
    // tool modules declare the one method they use (`SessionDirectories`) so
    // that importing the framework type — and the differently-pinned
    // `schemastery` copy it drags in — stays out of what this package compiles
    // and publishes. The lookup is also not in the typings when the service is
    // not mounted, hence the `| undefined` on the declared return.
    resolveWorkingDirectory: () => ctx.get('workingDirectory') as SessionDirectories | undefined,
  })
  ctx.effect(() => () => { for (const dispose of disposers) dispose() }, 'aishell-e2b: tools')

  // ── Credential changes ───────────────────────────────────────────────────
  //
  // The API key is bound to the AK that minted it (see `sandbox-key.ts`), so a
  // credential change already invalidates it *on the next call*. That check is
  // lazy, and lazy is not enough for a clear: between the clear and the next
  // sandbox call, the key still works at the gateway — which is the opposite of
  // what clearing credentials means.
  //
  // So the note is taken here and the key is dropped now. `aishell-credentials`
  // emits the same event for a save and a clear, and both warrant it: a
  // different account must not keep presenting the previous tenant's key.
  ctx.effect(() => ctx.on('aishell/credentials-updated', () => {
    keys.invalidate()
  }), 'aishell-e2b: credential changes')

  registerSandboxGuidance(ctx)
}
declare module '@deepseek-ai/cordis' {
  interface Events {
    /**
     * The stored Huawei Cloud credentials changed — a verified save, or a
     * clear. Emitted by `aishell-credentials`, which owns the credential form
     * and the store it writes.
     *
     * Declared here as well as on the emitting side because the two packages
     * share no import: this is the whole interface between them. A listener
     * reads the store itself; the event carries no value, so a secret can
     * never ride on it.
     *
     * @mode on
     */
    'aishell/credentials-updated'(): void
  }
}
