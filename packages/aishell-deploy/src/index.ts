/**
 * aishell deploy plugin — Huawei Cloud infrastructure tools for DSH.
 *
 * Terraform deployment workflows, OpenAPI calls, resource inventory and cost
 * estimates, as tools the model calls. The tool implementations live in
 * `tools/`, registered directly on the harness registry.
 *
 * ## What this plugin is
 *
 * One registration loop, one permission switch, one credential source.
 *
 *   - `bridge.ts` converts each tool's declaration into a DSH tool definition.
 *   - `permission/mode.ts` holds the read-only switch; `permission/gate.ts`
 *     enforces it, at the signed-HTTP funnel and at the tool registry.
 *   - `credentials.ts` reads the AK/SK pair from the store
 *     `aishell-credentials` writes, through the shared vocabulary in
 *     `credentials-store/accounts`.
 *
 * There is no second process, no transport, and no protocol in between: a tool
 * call runs in this process, and a credential rotation applies to the next
 * call with nothing to restart.
 *
 * ## The permission switch
 *
 * The mode is process state here. The Host route the composer chip calls reads
 * and writes it directly, so a switch takes effect before the next tool call
 * starts. The gate itself is enforced in `permission/gate.ts` — a refusal
 * cannot be talked around.
 *
 * ## What this plugin does not own
 *
 * Credentials. `aishell-credentials` owns the AK/SK form and the `aishell__auth`
 * tool; this plugin only reads the store. Mounted without it, the tools
 * register and every call fails with "not authenticated" until credentials
 * exist.
 *
 * @module @huaweidevtools/aishell-dsh-deploy
 */

import type { Context, Volatile } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
// Type-only: pulls the ctx.tools registry merge.
import type {} from '@deepseek-ai/dsh-tools'
// Type-only: pulls the ctx.connection merge (the authenticated fetch registry).
import type {} from '@deepseek-ai/dsh-client-connection'
import type {} from '@deepseek-ai/dsh-system-prompt'
import type { CredentialsStore } from '@huaweidevtools/aishell-dsh-credentials-store'
import { createCredentialsStore } from '@huaweidevtools/aishell-dsh-credentials-store'

import { createRegistrar, toToolDefinition } from './bridge.ts'
import { registerAllTools } from './tools/index.ts'
import { configureCredentials, forgetAccount } from './credentials.ts'
import { defaultMode, getMode, setMode, writesAllowed } from './permission/mode.ts'
import { createPermissionRoutes, PERMISSION_PATH } from './permission-route.ts'
import { registerPermissionPolicyContext } from './permission-context.ts'
import { registerDeployWorkflow } from './prompt.ts'

/**
 * Default per-call timeout for one tool.
 *
 * Ten minutes, not the 60 seconds a lookup-shaped tool would want: this
 * plugin's heaviest calls are terraform runs, and `terraform apply` of a real
 * network legitimately takes several. A budget shorter than the work it bounds
 * does not make the work safe — it reports a timeout on a deployment that was
 * still being created.
 *
 * It is still below the 30 minutes `runTerraform` allows its own subprocess. The
 * two are different questions: this is how long the HARNESS waits for one call,
 * that is how long a hung binary is left before it is killed. When the harness
 * budget wins, the run is cancelled and the tool reports a timeout, which is a
 * truthful statement about the call — while a 30-minute subprocess limit is what
 * stops the process from surviving a stall.
 */
const DEFAULT_TOOL_CALL_TIMEOUT_MS = 10 * 60 * 1000

/** Plugin config. */
export interface Config {
  /**
   * A region to fall back on when a plan does not name one.
   *
   * Undefined unless an operator sets it. Region is a property of each resource,
   * not of the account or the plugin: a deployment may span several, and a
   * default applied to all of them would silently price and provision the wrong
   * one. So there is no built-in value — a deployment that wants one says so
   * here, and the same value is what terraform is given as `HW_REGION_NAME`.
   */
  readonly defaultRegion: Volatile<string | undefined>
  /**
   * Per-call timeout in milliseconds.
   *
   * A real budget, not a formality: `terraform_apply` legitimately runs for
   * minutes. Defaulted high-ish for that reason rather than to the seconds a
   * lookup-shaped tool would want.
   */
  readonly toolCallTimeoutMs: Volatile<number>
}

/**
 * Settings schema.
 *
 * Every field is Volatile: each is a deployment fact that may differ between
 * profiles, and a change should apply to the next call rather than require a
 * restart. The bridge reads them through thunks for that reason.
 *
 * `defaultRegion` has no `.default()`. A built-in region would be a guess
 * dressed as configuration — the one thing this plugin must not do, because the
 * two places it is used (terraform's `HW_REGION_NAME` and the fallback price
 * region) must agree, and a wrong pair quotes one region while deploying to
 * another.
 */
export const Config = z.object({
  defaultRegion: z.string().volatile(),
  toolCallTimeoutMs: z.number().step(1).min(1).default(DEFAULT_TOOL_CALL_TIMEOUT_MS).volatile(),
})

export const name = 'aishell-deploy'

/**
 * Required services.
 *
 * `tools` is required: the whole point of this plugin is registering its tools.
 * `connection` is required because the permission route registers on the host's
 * authenticated fetch registry, and a plugin that silently lost its permission
 * switch would leave every mutation at the default.
 */
export const inject = ['tools', 'connection']

export function apply(ctx: Context, config: Config): void {
  // `ctx.logger(name)` is a factory, not a logger: it returns a scoped one and
  // takes the subsystem name as its argument.
  const log = ctx.logger('aishell-deploy')

  // One store, against the namespace every plugin in this set shares.
  const store: CredentialsStore = createCredentialsStore()

  // Every value is read through a thunk, never captured: the config is
  // Volatile, so an edit commits into the same references and this apply() does
  // not re-run. A snapshot would leave the settings surface and the tools
  // disagreeing until the next restart.
  configureCredentials({
    store,
    // Read through a thunk, and left undefined when the operator set nothing:
    // an unset region means "each resource's plan decides", not "cn-north-4".
    get region(): string | undefined { return config.defaultRegion.get() },
  })

  // ── Tools ────────────────────────────────────────────────────────────────
  //
  // The registrars are called once, into a capture surface; the captured list
  // is then converted into DSH definitions. Splitting it this way keeps the
  // tool modules untouched by the harness: they still call
  // `registerTool(name, declaration, handler)` and know nothing about DSH.
  const { registrar, captured } = createRegistrar()
  registerAllTools(registrar)

  // The host's session-directory service, looked up at call time rather than
  // captured: it may be mounted after this plugin is, and a snapshot would pin
  // "no service" for the rest of the process. Its absence is a supported state —
  // `paths.ts` then asks the caller for an absolute path instead of anchoring a
  // relative one at the host's own directory.
  const workingDirectory = (): SessionDirectories | undefined =>
    ctx.get('workingDirectory') as SessionDirectories | undefined

  const disposers = captured.map((tool) => {
    const definition = toToolDefinition(tool, config.toolCallTimeoutMs.get(), {
      ensure: (agent, signal) => requireSessionDirectories(workingDirectory()).ensure(agent, signal),
    })
    return ctx.tools.register(definition)
  })
  ctx.effect(() => () => { for (const dispose of disposers) dispose() }, 'aishell-deploy: tools')
  log.info(`registered ${disposers.length} Huawei Cloud tool(s)`)

  // ── Permission mode ──────────────────────────────────────────────────────
  //
  // The mode lives in this process. The route reads and writes the module
  // directly — no round trip, so a switch takes effect before the next call
  // starts rather than after the one already running.
  log.info(`permission mode: ${getMode()}`)

  const routes = createPermissionRoutes({
    // Read the live module each time rather than snapshotting: `writesAllowed()`
    // is what the gate consults, so reporting anything else here would let the
    // chip claim a mode the next tool call does not honour.
    read: () => ({ mode: getMode(), default: defaultMode(), writable: writesAllowed() }),
    write: (next) => {
      const previous = setMode(next)
      return { mode: getMode(), previous, changed: previous !== next }
    },
  })
  ctx.effect(() => ctx.connection.fetch.register({
    path: PERMISSION_PATH,
    methods: ['GET', 'POST'],
    requestBody: 'buffered',
    fetch: (request: Request): Promise<Response> => (
      request.method === 'GET' ? routes.get() : routes.set(request)
    ),
  }), 'aishell-deploy: permission route')

  registerPermissionPolicyContext(ctx, () => getMode())
  registerDeployWorkflow(ctx)

  // ── Credential changes ───────────────────────────────────────────────────
  //
  // The account identity is resolved from IAM and cached. `aishell-credentials`
  // announces every save and clear; dropping the cache here is what keeps a
  // deployment snapshot from recording the previous account after a rotation.
  // The credentials themselves need no invalidation — they are read from the
  // store on every call.
  ctx.effect(() => ctx.on('aishell/credentials-updated', () => {
    forgetAccount()
  }), 'aishell-deploy: credential cache')
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
     * reads the store itself; the event carries no value, so a secret can never
     * ride on it.
     *
     * @mode on
     */
    'aishell/credentials-updated'(): void
  }
}
/**
 * The session-directory service, as this plugin needs it.
 *
 * Structural rather than imported, for the reason `aishell-e2b` states: adding
 * the framework package for one method would drag in a duplicate `schemastery`
 * whose copy leaks into the emitted `.d.ts`. One method is all that is used.
 */
interface SessionDirectories {
  /** The session's effective absolute directory, validated and restored. */
  readonly ensure: (agent: object, signal?: AbortSignal) => Promise<string>
}

/**
 * The service when mounted, or one that reports its absence.
 *
 * `toToolDefinition` is built once, when the plugin activates, so a service
 * mounted later would never be seen if the value were captured. Returning a
 * wrapper keeps the lookup live: each call asks the context, which is the only
 * thing that knows what is mounted *now*.
 *
 * @param service - the service as it stands at this moment.
 * @returns the service, or a stand-in whose `ensure` refuses.
 */
function requireSessionDirectories(
  service: SessionDirectories | undefined,
): SessionDirectories {
  if (service !== undefined) return service
  return {
    ensure: () => Promise.reject(new Error('the host offers no working-directory service')),
  }
}
