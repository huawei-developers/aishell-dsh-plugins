/**
 * The sandbox a conversation works in.
 *
 * One conversation, one sandbox. That is the whole model: there is no
 * "which sandbox did you mean" question for the tools to ask, because there is
 * only ever one answer, and no `sandboxId` parameter for the model to get
 * wrong. The tools act on *the* sandbox, and creating one is the explicit act
 * that binds it to the conversation.
 *
 * ## Why the binding is created explicitly, never lazily
 *
 * A tool that quietly created a sandbox on first use would have to choose the
 * template and the lifetime itself, and those are exactly the two facts the
 * operator should be deciding — a preview page wants a different lifetime from
 * a debugging session, and that choice is the reason the create tool takes
 * parameters at all. A lazy create would move that decision into the plugin
 * and out of the conversation, where nobody can see it or correct it.
 *
 * So a tool with no sandbox bound fails, and names `aishell__sandbox_create` as the way
 * forward. The failure is cheap and legible; a silently invented sandbox is
 * neither.
 *
 * ## Why the binding survives a restart
 *
 * The mapping cannot live in memory alone. A plugin restart — a reload, a
 * crash, a profile edit — would otherwise orphan a running sandbox: the model
 * would find no binding, create a second sandbox, and the first would keep
 * billing until its lifetime expired, with nothing in the conversation
 * accounting for it.
 *
 * So the sandbox carries its conversation in its own `metadata` at creation,
 * and the registry rebuilds the binding by querying for it. The gateway
 * forwards `metadata` filters to the upstream unchanged, and
 * `Sandbox.list({ query: { metadata } })` is ordinary SDK surface, so the
 * recovery needs nothing from either service.
 *
 * A recovered binding is refused if the sandbox is not running. A paused
 * sandbox is not adopted: connecting to it would resume it and silently
 * restart its clock, which is a billing decision nobody asked for.
 *
 * @module @huaweidevtools/aishell-dsh-e2b/sandbox-registry
 */

/** The metadata key a sandbox carries its owning conversation under. */
export const SESSION_METADATA_KEY = 'aishell-session'

/** One sandbox the registry knows about. */
export interface BoundSandbox {
  /** The sandbox id. */
  readonly sandboxId: string
  /** Whether the gateway reports it as running. */
  readonly state: string
}

/** Lists the sandboxes carrying one metadata pair. */
export type SandboxFinder = (
  metadata: Record<string, string>,
  signal: AbortSignal | undefined,
) => Promise<ReadonlyArray<BoundSandbox>>

/** In-memory bindings plus the lookup used to rebuild them. */
export class SandboxRegistry {
  /** Session id → the sandbox bound to it. */
  private readonly bySession = new Map<string, string>()
  /** The metadata lookup, injected so tests need no gateway. */
  private readonly find: SandboxFinder

  constructor(find: SandboxFinder) {
    this.find = find
  }

  /**
   * Bind a sandbox to its conversation.
   *
   * @param sessionId - the owning conversation, or `undefined` for a call that
   *   ran outside one. Such a call is recorded nowhere: without a conversation
   *   to key on, there would be nothing to bind later calls to.
   * @param sandboxId - the sandbox to bind.
   */
  bind(sessionId: string | undefined, sandboxId: string): void {
    if (sessionId === undefined || sessionId === '') return
    this.bySession.set(sessionId, sandboxId)
  }

  /**
   * The sandbox this conversation is bound to, recovering the binding if this
   * process has not seen one.
   *
   * @param sessionId - the calling conversation.
   * @param signal - caller cancellation, forwarded to the lookup.
   * @returns the sandbox id, or `undefined` when the conversation has none.
   */
  async resolve(sessionId: string | undefined, signal?: AbortSignal): Promise<string | undefined> {
    if (sessionId === undefined || sessionId === '') return undefined
    const known = this.bySession.get(sessionId)
    if (known !== undefined) return known

    const found = await this.find({ [SESSION_METADATA_KEY]: sessionId }, signal)
    // Only a running sandbox is adopted. A paused one would have to be
    // resumed to be used, which restarts its clock — a billing decision the
    // operator did not make, so the model is told to create a sandbox instead.
    const running = found.find(candidate => candidate.state === 'running')
    if (running === undefined) return undefined
    this.bySession.set(sessionId, running.sandboxId)
    return running.sandboxId
  }

  /**
   * The sandbox bound right now, without a lookup.
   *
   * Used where a call has already resolved the binding and needs it again
   * without a second round trip.
   *
   * @param sessionId - the calling conversation.
   * @returns the bound sandbox id, or `undefined`.
   */
  bound(sessionId: string | undefined): string | undefined {
    if (sessionId === undefined || sessionId === '') return undefined
    return this.bySession.get(sessionId)
  }

  /**
   * Drop a binding, because the sandbox it names no longer exists.
   *
   * @param sandboxId - the sandbox that is gone.
   */
  forget(sandboxId: string): void {
    for (const [session, bound] of this.bySession) {
      if (bound === sandboxId) this.bySession.delete(session)
    }
  }
}

/** The metadata a new sandbox carries so its conversation can be recovered. */
export function sessionMetadata(
  sessionId: string | undefined,
  extra: Record<string, string> | undefined,
): Record<string, string> | undefined {
  const tags = { ...extra }
  if (sessionId !== undefined && sessionId !== '') tags[SESSION_METADATA_KEY] = sessionId
  return Object.keys(tags).length === 0 ? undefined : tags
}

/**
 * The message a tool gets when the conversation has no sandbox.
 *
 * Names the remedy, and deliberately does not offer to create one: the model
 * chooses the template and the lifetime, and it cannot do that from inside a
 * tool that was asked to write a file.
 */
export const NO_SANDBOX_MESSAGE =
  'aishell-e2b: this conversation has no sandbox. Call aishell__sandbox_create first, '
  + 'choosing the lifetime the work needs.'

/**
 * The message a tool gets when a sandbox existed but is now gone.
 *
 * Distinct from {@link NO_SANDBOX_MESSAGE} because the remedy differs: the
 * binding is stale rather than absent, and the model should know the previous
 * sandbox's contents are not recoverable — creating a new one starts empty.
 */
export const SANDBOX_GONE_MESSAGE =
  'aishell-e2b: the sandbox this conversation was using no longer exists '
  + '(it was deleted or its lifetime expired). Its contents are gone. '
  + 'Call aishell__sandbox_create to start a new one.'