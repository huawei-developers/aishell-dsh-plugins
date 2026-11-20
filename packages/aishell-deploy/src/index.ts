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
 * One mode per Session, held in this process. The Host route the composer chip
 * calls reads and writes it directly, so a switch takes effect before the next
 * tool call starts. The gate itself is enforced in `permission/gate.ts` — a
 * refusal cannot be talked around.
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
// Type-only: pulls the ctx.sessions merge and its branded id type.
import type { SessionId } from '@deepseek-ai/dsh-session'
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
import { clearCredentials, readStoredPair } from '@huaweidevtools/aishell-dsh-credentials-store/accounts'
import {
  applyStartupPosture, defaultPosture, forgetSession, getMode, installPermissionRecorder, pinSession,
  setDefaultPosture, setMode, type PermissionChange, type PermissionMode,
} from './permission/mode.ts'
import type {} from '@huaweidevtools/aishell-dsh-audit'
// Type-only: pulls the ctx.settings merge, so the account name another plugin
// recorded can be read from the shared settings document.
import type {} from '@deepseek-ai/dsh-settings'
import { createPermissionRoutes, PERMISSION_DEFAULT_PATH, PERMISSION_PATH } from './permission-route.ts'
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

/**
 * Settings namespace `aishell-credentials` records the verified account name
 * under.
 *
 * Its Loader row id, which is what the settings document keys a profile entry
 * by. Named here rather than imported: the two plugins share a document, not a
 * module, and a constant is a smaller coupling than a package dependency.
 */
const CREDENTIALS_SETTINGS_NS = 'aishell-client-credentials'

/**
 * How much of an access key an audit record shows.
 *
 * Four characters at each end. Access keys are long and opaque, so the leading
 * and trailing runs are what a person comparing a record against a console
 * recognises, while the middle stays out of a file that persists.
 */
const AK_VISIBLE_HEAD = 4
const AK_VISIBLE_TAIL = 4

/**
 * The subject an audit record names: the account, with the key masked.
 *
 * `name(AKID****WXYZ)`, or `(AKID****WXYZ)` when the account name is not known
 * — no credentials plugin mounted, or its first verification has not landed.
 * The masked key alone still identifies the account across records, so the
 * subject never has to be absent.
 *
 * @param accessKey - the stored access key.
 * @param name - the account name, when one has been verified.
 * @returns the label.
 */
function auditSubject(accessKey: string, name: string | undefined): string {
  // A key shorter than the two visible runs would be shown in full; the mask
  // is the point, so such a key is not labelled at all.
  const masked = accessKey.length > AK_VISIBLE_HEAD + AK_VISIBLE_TAIL
    ? `${accessKey.slice(0, AK_VISIBLE_HEAD)}****${accessKey.slice(-AK_VISIBLE_TAIL)}`
    : '****'
  return name === undefined ? `(${masked})` : `${name}(${masked})`
}

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
  /**
   * The posture new Sessions start in, as this deployment declares it.
   *
   * Read-only by default. A deployment whose conversations are expected to make
   * changes states it here, in the profile's patch: the patch is
   * version-controlled and visible to whoever reviews the profile, and the
   * declaration is the value every start reads.
   *
   * Not volatile: a posture is what a Session begins with, and Sessions that
   * already exist keep the answer they were pinned to when they started.
   * Editing this between calls leaves them as they are, so the field is a
   * start-up statement rather than a live one.
   */
  readonly startupPosture: PermissionMode
}

/**
 * Settings schema.
 *
 * A field is Volatile when its change should apply to the next call rather than
 * require a restart — a deployment fact that may differ between profiles. The
 * bridge reads those through thunks for that reason.
 *
 * `startupPosture` is plain: a posture is what a Session begins with, and
 * Sessions that already exist keep the answer they were pinned to, so the field
 * is read once at mount rather than per call.
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
  // The two modes as a union of constants rather than a string field: the
  // loader rejects a misspelling at start-up with the two accepted values in
  // the message, instead of this plugin receiving a third spelling and having
  // to decide what it means. Read-only is the default, so a deployment that
  // says nothing starts safe.
  startupPosture: z.union([z.const('read_only'), z.const('read_write')]).default('read_only'),
})

export const name = 'aishell-deploy'

/**
 * Required services.
 *
 * `tools` is required: the whole point of this plugin is registering its tools.
 * `connection` is required because the permission route registers on the host's
 * authenticated fetch registry, and a plugin that silently lost its permission
 * switch would leave every mutation at the default.
 * `sessions` is required because the permission mode is filed per Session: a
 * conversation is pinned to the posture when it starts, and the store is what
 * makes that possible for Sessions that exist before this plugin mounts.
 */
export const inject = ['tools', 'connection', 'sessions']

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
    // A tool call reaching IAM and being refused is the fastest evidence this
    // process will ever get that the stored pair has stopped working — a
    // temporary credential whose token expired, or a permanent key deleted in
    // the console. Either way the pair cannot be used again, and leaving it
    // stored keeps the credential card offering a signed-in view that cannot
    // work.
    //
    // Clearing goes through the same event `aishell-credentials` emits for its
    // own discard, so every consumer that caches something derived from the
    // pair — a resolved account, a sandbox key — drops it. The store is shared;
    // so is the notification.
    onRejected: () => {
      clearCredentials(store)
      forgetAccount()
      ctx.emit('aishell/credentials-updated')
    },
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
  // One mode per Session, held in this process. The route reads and writes the
  // module directly — no round trip, so a switch takes effect before the next
  // call starts rather than after the one already running.
  //
  // The order below is the posture's definition: the deployment's value is
  // applied first, then Sessions are pinned to it. Pinning comes after, so the
  // conversations already open when this plugin mounts start under the
  // declared value rather than under the module's default.
  applyStartupPosture(config.startupPosture)
  /**
   * The posture this process started in.
   *
   * Captured here, before any switch can be accepted, because the audit trail
   * records it as its first entry — and that record is written later, when the
   * audit service becomes available. Reading `defaultPosture()` at that point
   * would report the posture in force then: a deployment that switched the
   * posture before the audit plugin mounted would have its switch recorded as
   * the start, which the trail cannot then tell from a start nobody watched.
   */
  const startupPosture = defaultPosture()
  log.info(`permission posture for new sessions: ${startupPosture}`)

  // A Session's mode is keyed by an identity that will not be seen again once
  // it is disposed, so forgetting it here is what keeps a long-running process
  // from accumulating one entry per conversation it ever opened.
  ctx.effect(() => ctx.on('session/disposed', (session) => {
    forgetSession(session.id)
  }), 'aishell-deploy: forget disposed session modes')

  // A Session is pinned to the posture in force when it starts, which is what
  // keeps a later posture change from reaching a conversation already on
  // screen. `session/created` fires for a restored Session too; a restore
  // arrives with no entry, so it takes the posture this process started with,
  // while a conversation that is already running keeps its own.
  ctx.effect(() => ctx.on('session/created', (session) => {
    pinSession(session.id)
  }), 'aishell-deploy: pin created session modes')

  // Sessions that exist at mount are pinned to the posture in force now: their
  // start predates this plugin, so the posture they began under is not a fact
  // the plugin can still observe. From here on they carry their own entry,
  // which is the same rule every later Session gets.
  for (const session of ctx.sessions.list()) pinSession(session.id)

  // ── Audit ────────────────────────────────────────────────────────────────
  //
  // The mode governs what may be mutated in the operator's Huawei Cloud
  // account, so "who granted write access, and when" has to be answerable
  // afterwards. Records go to the audit service, which owns the destination;
  // this plugin only decides when something is worth recording.

  /**
   * The account name `aishell-credentials` recorded after verifying the pair
   * against IAM.
   *
   * Read from the settings document rather than by asking IAM: a mode switch is
   * synchronous, and a label is not worth a round trip inside it. Absent when
   * that plugin is not mounted, or before its first verification — the subject
   * then carries only the masked access key, which still identifies the account
   * across records.
   *
   * Read per record rather than captured: a rotation changes the account, and a
   * captured name would attribute a later switch to the previous one.
   */
  const accountName = (): string | undefined => {
    const descriptor = ctx.get('settings')?.describe()
      .find(entry => entry.ns === CREDENTIALS_SETTINGS_NS)
    const value = descriptor?.value as { accessKeyIdHint?: unknown } | undefined
    return typeof value?.accessKeyIdHint === 'string' && value.accessKeyIdHint.length > 0
      ? value.accessKeyIdHint
      : undefined
  }

  // `ctx.inject` rather than a `ctx.get` at mount: the audit plugin is a
  // separate row whose position in the bundle is not this plugin's to decide,
  // and a deployment may not mount it at all. `inject` runs the callback when
  // the service exists, whenever that is, which keeps the trail wired without
  // making it a requirement.
  ctx.inject(['audit'], (auditCtx) => {
    /**
     * Record one mode change.
     *
     * The account is read here rather than passed in, so a record names the
     * account in force at that moment: after a rotation, the previous account
     * would be the wrong attribution.
     */
    const recordChange = (change: PermissionChange): void => {
      // The switch is the decision a person made; the trail describes it and
      // does not authorise it. Nothing here can fail the switch, so a record
      // that could not be written is a gap in the trail — never a permission
      // change that silently did not take effect.
      try {
        const ak = readStoredPair(store)?.ak
        auditCtx.audit.record({
          action: 'permission.mode',
          // The direction, not just "it changed": a grant and its reversal read
          // differently, and an auditor should not have to know the mode
          // vocabulary to tell which way a switch went.
          outcome: change.mode === 'read_write' ? 'granted' : 'revoked',
          ...(ak === undefined ? {} : { subject: auditSubject(ak, accountName()) }),
          actor: change.actor,
          detail: {
            ...change.previous === undefined
              // A mode nothing preceded has nothing it came from, and naming one
              // would describe a transition that never happened.
              ? { to: change.mode }
              : { from: change.previous, to: change.mode },
            // Which conversation the switch applies to. A posture change names
            // none, and the record then describes what new Sessions start in
            // rather than a conversation somebody was looking at.
            ...change.session === undefined ? {} : { session: change.session },
          },
        })
      } catch {
        // Silent, like an uninstalled recorder: this plugin owns the trail but
        // not its sink, and a failure here has already been reported by whoever
        // owns the file. A message on stderr would reach a terminal rather than
        // the trail it belongs in.
      }
    }

    // The posture new Sessions started in is part of the trail, recorded before
    // any switch: a log whose first entry is a person weakening that posture
    // cannot be told from one where nobody was watching before it. The value is
    // the one captured at mount, not read now — this body runs when the audit
    // service becomes available, which can be after a switch was accepted.
    recordChange({ session: undefined, previous: undefined, mode: startupPosture, actor: 'startup' })

    // Every later change passes through `setMode`, so installing the recorder
    // there is what makes the trail gapless: no caller has to remember.
    auditCtx.effect(() => installPermissionRecorder(recordChange),
      'aishell-deploy: permission audit recorder')
  })

  const routes = createPermissionRoutes({
    // A Session the store does not hold cannot own a mode: the entry would
    // outlive the conversation it describes, and a future Session reusing that
    // id would read a grant nobody gave it.
    known: (session) => ctx.sessions.get(session as SessionId) !== undefined,
    // Read the live module each time rather than snapshotting: `getMode()` is
    // what the gate consults, so reporting anything else here would let the
    // chip claim a mode the next tool call does not honour.
    read: (session) => ({ mode: getMode(session) }),
    write: (session, next) => {
      // `setMode` records the change; a re-assertion of the current mode
      // reports the same state back to the chip without claiming the operator
      // did something they did not.
      const previous = setMode(session, next)
      return { mode: getMode(session), previous, changed: previous !== next }
    },
    readDefault: () => defaultPosture(),
    writeDefault: (next) => setDefaultPosture(next),
  })
  ctx.effect(() => ctx.connection.fetch.register({
    path: PERMISSION_PATH,
    methods: ['GET', 'POST'],
    requestBody: 'buffered',
    fetch: (request: Request): Promise<Response> => (
      request.method === 'GET' ? routes.get(request) : routes.set(request)
    ),
  }), 'aishell-deploy: permission route')
  // The posture's own path: setting what new Sessions start in takes a route a
  // caller cannot reach by omitting a field from a conversation's request.
  ctx.effect(() => ctx.connection.fetch.register({
    path: PERMISSION_DEFAULT_PATH,
    methods: ['GET', 'POST'],
    requestBody: 'buffered',
    fetch: (request: Request): Promise<Response> => (
      request.method === 'GET' ? routes.getDefault() : routes.setDefault(request)
    ),
  }), 'aishell-deploy: permission posture route')

  registerPermissionPolicyContext(ctx, (session) => getMode(session))
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
