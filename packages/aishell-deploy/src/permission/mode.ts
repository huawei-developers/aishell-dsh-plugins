/**
 * Approval mode — the out-of-band read-only / read-write switch.
 *
 * ## What this gates
 *
 * Read-only mode protects **HuaweiCloud resources**: it stops the agent from
 * creating, modifying, or deleting anything in the account. It is not a
 * sandbox. Operations with no cloud effect — a terraform binary run, a plan
 * file written to disk, a local command — are outside what this switch can
 * see, and are not claimed to be covered.
 *
 * ## Why the mode lives here and not in the conversation
 *
 * The switch is out-of-band: a human flips it in the client UI, which reaches
 * this process over the authenticated Host route (`../permission-route.ts`), and
 * this module's memory changes.
 *
 * The mode is not an exposed surface: it appears in no tool description, no
 * tool result, and no `tools/list` entry, and no tool sets it. An agent cannot
 * read it on demand, and cannot argue its way into write access.
 *
 * A denial, however, does reveal the current state — `denyTool` and `denyHttp`
 * name read-only mode in the message they return. That is deliberate, and it
 * is not closable by wording: were the session in read-write the request would
 * not be refused at all, so the mere fact of refusal carries the same one bit
 * whatever the text says. A refusal that explained nothing would only make the
 * model retry and leave the user without a remedy. The state is one-way
 * observable at the moment it blocks you, and one-way unchangeable — which is
 * the property that matters.
 *
 * ## One mode per Session
 *
 * The mode belongs to a Session, not to the process: two conversations open in
 * one window are two decisions, and granting write access to review something
 * here must not widen what an agent is doing there. A Session's mode is the one
 * a person set for it, or — until there is one — the posture this process was
 * asked to give new Sessions.
 *
 * The posture decides what a Session begins with, never what it is later set
 * to. A conversation that is already on screen keeps the answer it started
 * with, so a deployment can raise the posture for work it is about to start
 * without widening one a person is already reading.
 *
 * ## What a restart guarantees
 *
 * Neither a Session's mode nor the posture is persisted, so a restart returns
 * both to read-only. A conversation that needs write access is granted it again,
 * which is the safe direction to fail. A deployment that wants new Sessions to
 * start in write access states that after start-up, over
 * `POST api/aishell/permission/default` — the posture is a running decision, not
 * a stored one, so nothing survives that would disagree with it.
 *
 * @module permission/mode
 */

/** Whether mutations are permitted. */
export type PermissionMode = "read_only" | "read_write";

/** One conversation. The key every mode in this module is filed under. */
export type SessionKey = string;

/** Who set the mode. */
export type PermissionActor = "user" | "startup";

/** One recorded mode change, and the Session it applies to. */
export interface PermissionChange {
  /**
   * The Session whose mode changed, or `undefined` for the posture new Sessions
   * start in.
   *
   * A posture change is not a change to any conversation on screen, so it names
   * no Session — the record's `detail` carries the posture it set instead.
   */
  readonly session: SessionKey | undefined;
  /**
   * The mode before the change, or `undefined` when there was none to be in.
   *
   * A Session with no mode of its own was in the posture, and a posture that
   * nothing has changed yet has no predecessor either: naming one would record
   * a transition that never happened.
   */
  readonly previous: PermissionMode | undefined;
  readonly mode: PermissionMode;
  /** The person at the console, or the posture the process started with. */
  readonly actor: PermissionActor;
}

/**
 * Records one change; installed by the plugin, which owns the audit service.
 *
 * A module-level hook rather than an import of the audit service: this module is
 * pure state with no context, so it cannot reach `ctx.audit` itself. The plugin
 * installs the recorder at startup, and an uninstalled recorder is silent —
 * `setMode` runs in tests and before the plugin is applied, neither of which is
 * a reason for a mode change to fail.
 */
let recordChange: ((change: PermissionChange) => void) | undefined;

/**
 * Install the recorder for mode changes.
 *
 * One recorder at a time: a second install replaces the first rather than
 * joining it. A trail must not depend on how many times a plugin was loaded,
 * and two recorders would write every change twice.
 *
 * @param record - receives every real change, or `undefined` to stop recording.
 * @returns the disposer, which stops recording only if this is still the
 *   installed recorder — a late dispose cannot uninstall a successor.
 */
export function installPermissionRecorder(
  record: ((change: PermissionChange) => void) | undefined,
): () => void {
  recordChange = record;
  return () => {
    if (recordChange === record) recordChange = undefined;
  };
}

/**
 * The posture every Session starts in.
 *
 * Read-only unless the deployment asked for otherwise before any conversation
 * opened. A Session is pinned to this value when it is created, so a later
 * change reaches only Sessions that have not started yet.
 */
const STARTUP_POSTURE: PermissionMode = "read_only";

/** The posture new Sessions are pinned to. Not retroactive — see the module header. */
let posture: PermissionMode = STARTUP_POSTURE;

/** Modes by Session. Every created Session has an entry; `posture` covers the rest. */
const modes = new Map<SessionKey, PermissionMode>();

/** The mode one Session may act under. */
export function getMode(session: SessionKey | undefined): PermissionMode {
  if (session === undefined) return posture;
  return modes.get(session) ?? posture;
}

/**
 * The posture new Sessions start in.
 *
 * Read through a function rather than exported as a value: the route and the
 * client both report it, and a snapshot taken at import time would go stale the
 * first time a deployment sets it.
 */
export function defaultPosture(): PermissionMode {
  return posture;
}

/**
 * Set one Session's mode.
 *
 * ## Why the notification lives here
 *
 * Every change passes through this function, so notifying here is what makes
 * the record gapless. A separate call each caller has to remember would leave a
 * change unrecorded the first time someone added a caller and forgot — and a
 * trail with a gap is worse than none, because it reads as complete.
 *
 * A re-assertion of the mode already in force is not a change and is not
 * notified: the chip re-reads the state after every call, and recording those
 * would fill the trail with actions nobody took.
 *
 * A mode is stored under its Session for as long as that Session lives, whatever
 * its value. Only a Session that has never been given one follows the posture;
 * once a conversation has an answer of its own, that answer is the one it keeps,
 * so a later posture change cannot revise a decision already made about it.
 *
 * @param session - the Session the mode applies to.
 * @param mode - the mode to apply.
 * @param actor - who is setting it; the route is the only production caller, so
 *   the default is the person at the console.
 * @returns the mode the Session was in, for a change log.
 */
export function setMode(
  session: SessionKey,
  mode: PermissionMode,
  actor: PermissionActor = "user",
): PermissionMode {
  const previous = getMode(session);
  modes.set(session, mode);
  if (previous !== mode) recordChange?.({ session, previous, mode, actor });
  return previous;
}

/**
 * Whether one Session may mutate the cloud.
 *
 * `undefined` is "no Session" — a call outside a conversation, which answers
 * with the posture. Every production tool call carries a Session, so that arm
 * describes a call this plugin does not place in any conversation; it is not a
 * separate policy, and a deployment that widened the posture widened it too.
 */
export function writesAllowed(session: SessionKey | undefined): boolean {
  return getMode(session) === "read_write";
}

/**
 * Give one Session its own mode, decided by the posture in force at creation.
 *
 * Every Session carries an entry from the moment it exists, which is what makes
 * a posture change reach only Sessions that have not started. A Session pinned
 * here keeps the answer it was created with, so a conversation on screen is
 * never widened from underneath the person reading it.
 *
 * @param session - the Session being created.
 */
export function pinSession(session: SessionKey): void {
  if (!modes.has(session)) modes.set(session, posture);
}

/**
 * Set the posture new Sessions start in.
 *
 * Every Session already has an entry of its own, so this decides what Sessions
 * created from now on begin with and leaves existing conversations as they are.
 *
 * @param mode - the posture to apply.
 * @returns the posture it replaced.
 */
export function setDefaultPosture(mode: PermissionMode): PermissionMode {
  const previous = posture;
  posture = mode;
  // Recorded as the posture's own change, with no Session: the conversations
  // this affects do not exist yet, and naming one would describe a switch
  // somebody made to a conversation they were looking at.
  if (previous !== mode) recordChange?.({ session: undefined, previous, mode, actor: "user" });
  return previous;
}

/**
 * Forget one Session's mode.
 *
 * Called when the Session is disposed: the map is keyed by an identity that
 * will not be seen again, and a long-running process opens sessions for as long
 * as it runs.
 */
export function forgetSession(session: SessionKey): void {
  modes.delete(session);
}

/**
 * Reset to the startup posture, without recording.
 *
 * A test affordance: it restores the state the module is initialised with, so
 * it is not an event in the process's history and there is nothing for an audit
 * trail to say about it.
 */
export function resetMode(): void {
  posture = STARTUP_POSTURE;
  modes.clear();
}