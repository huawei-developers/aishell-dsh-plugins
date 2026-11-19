/**
 * Which Session a call is being made for.
 *
 * ## Why the Session travels with the call
 *
 * The mode belongs to a Session, so every gate has to know which one it is
 * gating. The tool registry gate is handed that by the harness: a tool executes
 * with the calling agent, whose id is the Session. The signed-HTTP funnel is
 * not — it sits several layers below the tool, behind helpers that build a
 * request without knowing whose it is.
 *
 * A `session` parameter threaded through those helpers would leave the answer
 * to each one remembering to pass it. A helper that did not would read the
 * posture instead of the Session and permit a call the Session refuses — a gate
 * with a hole in it, silently. So the Session is ambient to the call rather than
 * an argument in it: the funnel cannot be reached without it.
 *
 * ## How it travels
 *
 * A store that follows the asynchronous work a call creates. The tool executor
 * runs each handler inside {@link runForSession}, so everything the handler
 * awaits — the helper that builds the request, the funnel that signs it — reads
 * the same Session without a parameter in sight.
 *
 * The store follows the whole asynchronous resource graph, not only the `await`
 * chain: a timer, a promise chain, a queue callback scheduled during the call
 * all still see its Session. What it does not follow is work detached from the
 * process — a task handed to a worker, or one queued before the call began. A
 * caller that defers a request that far captures the Session itself.
 *
 * @module permission/call-context
 */

import { AsyncLocalStorage } from "node:async_hooks";

import type { SessionKey } from "./mode.js";

/** One call's Session, as read inside the asynchronous chain serving it. */
const storage = new AsyncLocalStorage<SessionKey>();

/**
 * Run one call with its Session in scope.
 *
 * @param session - the Session the call is made for.
 * @param body - the work; anything it awaits reads the same Session.
 * @returns whatever `body` returns.
 */
export function runForSession<T>(session: SessionKey, body: () => T): T {
  return storage.run(session, body);
}

/**
 * Run one call that belongs to no Session.
 *
 * The store would otherwise be inherited from whatever call is already in
 * scope, which would credit this call to a conversation it is not part of. A
 * call the harness gave no Session belongs to no conversation, and the gates
 * judge it by the posture — the same answer as a call made outside any tool
 * execution.
 *
 * @param body - the work.
 * @returns whatever `body` returns.
 */
export function runWithoutSession<T>(body: () => T): T {
  return storage.exit(body);
}

/**
 * The Session the current call serves, if any.
 *
 * `undefined` outside any call this plugin placed in scope: at module level, on
 * work detached from the process, or inside a call the harness gave no Session.
 * The gate treats that as a call with no Session rather than inventing one.
 *
 * @returns the Session key, or `undefined`.
 */
export function currentSession(): SessionKey | undefined {
  return storage.getStore();
}