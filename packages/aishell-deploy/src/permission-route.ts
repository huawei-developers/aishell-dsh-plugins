/**
 * Host route for the permission mode switch.
 *
 * The composer chip lives in the browser and the mode lives in this process.
 * A settings document cannot carry that toggle — it is out-of-band state the
 * model must neither see nor set — so this route carries it the same way the
 * credential route carries secrets: an authenticated browser-to-host HTTP
 * round trip.
 *
 * `GET  api/aishell/permission` -> current mode
 * `POST api/aishell/permission` <- { mode } -> the applied change
 *
 * ## How the mode is reached
 *
 * The deps are two functions over this plugin's own module state, so a switch
 * takes effect before the next tool call starts rather than after a round
 * trip.
 *
 * ## Errors are reported, not thrown
 *
 * The route answers 200 with `{ ok: false, error }` so the chip can show the
 * message. Only a malformed request earns a 4xx. The two remaining failure
 * modes are both malformed input, so `ok: false` now covers request validation
 * only — but the envelope is unchanged, because the client half already
 * renders it and a shape change would be a second thing to keep in step.
 *
 * @module @huaweidevtools/aishell-dsh-deploy/permission-route
 */

import {
  PERMISSION_MODES,
  type PermissionMode,
  type PermissionModeState,
  type PermissionModeChange,
} from './permission.ts'

/** Route path, mounted under the host's authenticated `/api` fence. */
export const PERMISSION_PATH = '/api/aishell/permission'

/** What this route needs: the plugin's own mode state. */
export interface PermissionRouteDeps {
  /** Read the mode now in effect, with the startup default and writability. */
  readonly read: () => PermissionModeState
  /** Apply a mode; returns the change so the browser can render it. */
  readonly write: (mode: PermissionMode) => PermissionModeChange
}

/** A successful response: the mode now in effect. */
export interface PermissionStatus extends PermissionModeState {
  readonly ok: true
}

/**
 * A failed response.
 *
 * Still carries no `mode`, `default`, or `writable`. Validation failures are
 * the only remaining source, but the rule stays: a request that could not be
 * answered must not be answered with a guess.
 */
export interface PermissionFailure {
  readonly ok: false
  /** Human-readable reason; rendered by the client's form. */
  readonly error: string
}

/** JSON response helper. */
function json(body: unknown, status = 200): Response {
  return Response.json(body, { status })
}

/**
 * Report the current mode.
 *
 * @param deps - route collaborators.
 */
export function getMode(deps: PermissionRouteDeps): Promise<Response> {
  return Promise.resolve(json({ ok: true, ...deps.read() } satisfies PermissionStatus))
}

/**
 * Apply a mode.
 *
 * @param deps - route collaborators.
 * @param request - the incoming POST; its body carries `{ mode }`.
 */
export async function setMode(deps: PermissionRouteDeps, request: Request): Promise<Response> {
  let body: unknown
  try {
    body = await request.json()
  } catch {
    return json({ ok: false, error: 'Request body is not valid JSON.' }, 400)
  }

  const mode = (body as { mode?: unknown } | null | undefined)?.mode
  if (typeof mode !== 'string' || !(PERMISSION_MODES as readonly string[]).includes(mode)) {
    return json(
      { ok: false, error: `mode must be one of: ${PERMISSION_MODES.join(', ')}` },
      400,
    )
  }

  const change = deps.write(mode as PermissionMode)
  return json({ ok: true, ...change })
}

/**
 * Build the route handlers.
 *
 * @param deps - route collaborators.
 * @returns handlers for the fetch registry.
 */
export function createPermissionRoutes(deps: PermissionRouteDeps): {
  get: () => Promise<Response>
  set: (request: Request) => Promise<Response>
} {
  return {
    get: () => getMode(deps),
    set: (request: Request) => setMode(deps, request),
  }
}