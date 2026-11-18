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
 * The mode is deliberately not persisted. A restart returns to the default,
 * so a session that needs write access must be granted it again — the safe
 * direction to fail.
 *
 * @module permission/mode
 */

/** Whether mutations are permitted. */
export type PermissionMode = "read_only" | "read_write";

/** Who set the mode. */
export type PermissionActor = "user" | "startup";

/** One recorded mode change. */
export interface PermissionChange {
  /**
   * The mode before the change, or `undefined` when the process started in
   * this one.
   *
   * A startup mode has no predecessor: it was not reached from another mode,
   * and naming one would record a transition that never happened.
   */
  readonly previous: PermissionMode | undefined;
  readonly mode: PermissionMode;
  /** The person at the console, or the configuration the process started with. */
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
 * Environment variable holding the startup default.
 *
 * Read once at module load and never re-read, so the mode cannot be changed
 * by anything the agent can influence at runtime. It is intentionally absent
 * from every tool description and from the prompt: it is an operator knob,
 * not something the model is meant to reason about.
 */
const DEFAULT_MODE_ENV = "HW_DEFAULT_PERMISSION";

/** The mode when nothing overrides it. */
const FALLBACK_MODE: PermissionMode = "read_only";

/**
 * Parse a mode string.
 *
 * Accepts the wire spellings plus a few the operator is likely to type in an
 * environment variable. Anything unrecognised yields `undefined` rather than
 * throwing, so a typo degrades to the default instead of failing startup.
 *
 * @param value - candidate string.
 * @returns the mode, or `undefined` when unrecognised.
 */
export function parseMode(value: string | undefined): PermissionMode | undefined {
  if (value === undefined) return undefined;
  switch (value.trim().toLowerCase()) {
    case "read_only":
    case "read-only":
    case "readonly":
    case "ro":
      return "read_only";
    case "read_write":
    case "read-write":
    case "readwrite":
    case "rw":
      return "read_write";
    default:
      return undefined;
  }
}

/**
 * The mode this process started in.
 *
 * Resolved once, at load. The environment variable is an operator's input to a
 * running process, not a live setting: re-reading it would let a runtime change
 * of the variable move the "startup default" that `resetMode` restores and that
 * `/permission/get_mode` reports, which is a fact about the past.
 */
const STARTUP_MODE: PermissionMode = parseMode(process.env[DEFAULT_MODE_ENV]) ?? FALLBACK_MODE;

/** Current mode. Module-level state — one server instance per connection. */
let current: PermissionMode = STARTUP_MODE;

/** The mode in effect. */
export function getMode(): PermissionMode {
  return current;
}

/**
 * Set the mode.
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
 * @param mode - the mode to apply.
 * @param actor - who is setting it; the route is the only production caller, so
 *   the default is the person at the console.
 * @returns the previous mode, for a change log.
 */
export function setMode(
  mode: PermissionMode,
  actor: PermissionActor = "user",
): PermissionMode {
  const previous = current;
  current = mode;
  if (previous !== mode) recordChange?.({ previous, mode, actor });
  return previous;
}

/** Whether mutations are currently permitted. */
export function writesAllowed(): boolean {
  return current === "read_write";
}

/**
 * Reset to the startup default, without recording.
 *
 * A test affordance: it restores the state the module is initialised with, so
 * it is not an event in the process's history and there is nothing for an audit
 * trail to say about it.
 */
export function resetMode(): void {
  current = STARTUP_MODE;
}

/** The mode this process started in, for logging and for `permission/get_mode`. */
export function defaultMode(): PermissionMode {
  return STARTUP_MODE;
}