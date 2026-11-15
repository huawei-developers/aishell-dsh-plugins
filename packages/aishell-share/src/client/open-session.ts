/**
 * Opening a session the Host has only just written.
 *
 * ## The order
 *
 * A session the Host accepted is not in this client's list snapshot yet —
 * snapshots are pulled, and the write happened after the last pull. Opening one
 * that is in neither the live set nor the summaries throws `sessions.retain:
 * unknown session`, and `openSession` does not report it: the import is
 * accepted, the dialog closes on success, and no session appears. The pull has
 * to land before the id is resolved.
 *
 * ## A failed pull still opens
 *
 * The session exists. The Host wrote it and answered with its id, and that id
 * is what the import was given. A pull that failed, or that raced the Host's
 * own listing, leaves the *list* stale — which is the transient part.
 * Declining to open would turn a slow refresh into an import that produced
 * nothing visible.
 *
 * Split from the plugin body because the ordering is the whole content of the
 * fix, and the body cannot be driven without a shell: this takes plain
 * callbacks, so the order and the failure paths are pinned by a spec.
 *
 * @module @huaweidevtools/aishell-dsh-share/client/open-session
 */

/** What one open needs from the shell. */
export interface OpenSessionDeps {
  /**
   * Pull the Host-authoritative session list.
   *
   * @returns completion of the pull; a rejection is tolerated by the caller.
   */
  readonly refresh: () => Promise<void>
  /**
   * Navigate to a session, as clicking its sidebar row does.
   *
   * Throws when the id is still unknown to the shell. Reported rather than
   * swallowed: the alternative is a rejected promise nobody handles, which is
   * the same silence the ordering exists to remove.
   *
   * @param sessionId - the id to open.
   */
  readonly open: (sessionId: string) => void
  /**
   * Report a navigation that threw.
   *
   * @param error - what the shell threw.
   * @param sessionId - the id that could not be opened.
   */
  readonly onOpenFailed?: (error: unknown, sessionId: string) => void
}

/**
 * Refresh the list, then open the session.
 *
 * `open` runs inside this function's own async body rather than in a `.then`
 * callback at the call site: `openSession` throws synchronously when the id is
 * unknown, and a throw from a callback becomes a rejected promise nobody
 * handles. Here the throw is caught and handed to `onOpenFailed`, so a failed
 * navigation leaves a diagnostic instead of silence.
 *
 * @param sessionId - the session the Host has just written.
 * @param deps - the pull, the navigation, and where a failure goes.
 * @returns completion of the attempt; a failed pull or a failed open does not
 *   reject it.
 */
export async function openSessionAfterRefresh(
  sessionId: string,
  deps: OpenSessionDeps,
): Promise<void> {
  try {
    await deps.refresh()
  } catch {
    // The session exists; a stale list is what failed. Navigation below is
    // still the attempt worth making — see the module note.
  }
  try {
    deps.open(sessionId)
  } catch (error) {
    deps.onOpenFailed?.(error, sessionId)
  }
}