/**
 * The permission mode vocabulary the route and the prompt share.
 *
 * The mode itself lives in `./permission/mode.ts`, next to the gate that
 * enforces it — the tools read it directly (`writesAllowed()`, `getMode()`), so
 * there is no client half to write and no request to make.
 *
 * What stays here is the *wire* vocabulary: the two spellings the browser sends
 * and the shapes the route answers with. Declared separately from the internal
 * module rather than imported from it, so a change to the module's internal
 * naming cannot silently change the wire.
 *
 * @module @huaweidevtools/aishell-dsh-deploy/permission
 */

/** The two modes, spelled as the browser sends them. */
export const PERMISSION_MODES = ['read_only', 'read_write'] as const

/** One permission mode. */
export type PermissionMode = (typeof PERMISSION_MODES)[number]

/** Result of `GET api/aishell/permission`. */
export interface PermissionModeState {
  /** Mode now in effect. */
  readonly mode: PermissionMode
  /** Mode this process started in. */
  readonly default: PermissionMode
  /** Whether mutations are currently permitted. */
  readonly writable: boolean
}

/** Result of `POST api/aishell/permission`. */
export interface PermissionModeChange {
  /** Mode now in effect. */
  readonly mode: PermissionMode
  /** Mode before the call. */
  readonly previous: PermissionMode
  /** Whether the mode actually changed. */
  readonly changed: boolean
}