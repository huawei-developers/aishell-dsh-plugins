/**
 * Recording an imported session in the Workspace that owns its directory.
 *
 * ## Why this is a module of its own
 *
 * It is the half of the import that the persistence write cannot do. Writing a
 * session stores it; it does not put it in a Workspace. Membership is an
 * explicit registry list, so a session whose header names a directory but which
 * nobody attached is listed under the ungrouped section — no error, no warning,
 * nothing but a row in the wrong place.
 *
 * Split out because that is the only part of the import a test can drive: the
 * write needs a real persistence backend, while this takes a registry and a
 * logger. Keeping it in `index.ts` would have meant exporting a helper from the
 * plugin's own entry, which is what the loader reads.
 *
 * @module @huaweidevtools/aishell-dsh-share/attach
 */

import type { Context } from '@deepseek-ai/cordis'

/**
 * The part of the Workspace registry this module uses.
 *
 * Declared rather than imported: `@deepseek-ai/dsh-workspace` is a package a
 * composition may not mount, and importing its type would make this package
 * depend on something that need not be present. Two members are all that is
 * used — the registry's order, and the attach that revalidates the header.
 */
export interface WorkspaceRegistry {
  readonly list: () => readonly {
    readonly path: string
    readonly attachSession: (sessionId: string) => Promise<void>
  }[]
}

/**
 * Record a freshly written session in the Workspace that owns its directory.
 *
 * The registry is read at call time rather than declared in this plugin's
 * `inject`: a deployment without Workspaces has no groups to join, and requiring
 * the service would refuse to load the plugin over a sidebar feature it does not
 * need. `attachSession` is the same call a session created in that Workspace goes
 * through — it revalidates the stored header against the registry's canonical
 * path, so an id is attached only when the copy really is filed there.
 *
 * A failure is logged and not surfaced: the session is written and openable, and
 * the only thing lost is its place in a group. Reporting it as a failed import
 * would tell the reader their conversation did not arrive when it did.
 *
 * @param ctx - host context.
 * @param sessionId - the session just written.
 * @param cwd - the workspace directory it was filed under.
 * @param log - where a failure is recorded.
 */
export async function attachToWorkspace(
  ctx: Context,
  sessionId: string,
  cwd: string,
  log: { warn: (message: string) => void },
): Promise<void> {
  const registry = ctx.get('workspaceRegistry') as WorkspaceRegistry | undefined
  if (registry === undefined) return
  const workspace = registry.list().find((candidate) => candidate.path === cwd)
  if (workspace === undefined) {
    log.warn(`imported session ${sessionId} has no Workspace at ${cwd}`)
    return
  }
  try {
    await workspace.attachSession(sessionId)
  } catch (error) {
    log.warn(`could not attach imported session ${sessionId} to ${cwd}: ${String(error)}`)
  }
}