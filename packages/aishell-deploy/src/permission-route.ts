/**
 * Host route for the permission mode switch.
 *
 * The composer chip lives in the browser and the mode lives in this process.
 * A settings document cannot carry that toggle — it is out-of-band state the
 * model must neither see nor set — so this route carries it the same way the
 * credential route carries secrets: an authenticated browser-to-host HTTP
 * round trip.
 *
 * `GET  api/aishell/permission?session=<id>`        -> that Session's mode
 * `POST api/aishell/permission`  { session, mode }  -> the applied change
 * `GET  api/aishell/permission/default`             -> the posture
 * `POST api/aishell/permission/default` { mode }    -> the posture
 *
 * ## Why the Session is required and never inferred
 *
 * The mode belongs to one conversation, so a request that does not name one is
 * a request this route cannot answer. A process-wide value would report or apply
 * that value to conversations the caller was not looking at — the one thing
 * per-Session modes exist to prevent. So an absent or unusable Session is
 * refused with a 4xx, and a Session the store does not hold is answered `404`.
 *
 * ## The posture endpoint is separate
 *
 * Setting what new Sessions start in is a deployment decision, not a switch on
 * one conversation; it takes its own path so a caller cannot reach it by
 * omitting a field. It decides what Sessions created from now on begin with and
 * leaves existing ones alone (see `permission/mode.ts`).
 *
 * ## How the mode is reached
 *
 * The deps are functions over this plugin's own module state, so a switch takes
 * effect before the next tool call starts rather than after a round trip.
 *
 * ## Errors are reported, not thrown
 *
 * The route answers 200 with `{ ok: false, error }` so the chip can show the
 * message. A request the route cannot answer is refused with a 4xx instead:
 * a missing or unusable Session is a malformed request, and one naming a
 * Session the store does not hold is answered `404` rather than given a mode
 * for a conversation that does not exist. The envelope is unchanged, because
 * the client half already renders it and a shape change would be a second
 * thing to keep in step.
 *
 * @module @huaweidevtools/aishell-dsh-deploy/permission-route
 */

import {
  PERMISSION_MODES,
  type PermissionMode,
  type PermissionModeState,
  type PermissionModeChange,
} from './permission.ts'
import type { SessionKey } from './permission/mode.ts'

/** Route path, mounted under the host's authenticated `/api` fence. */
export const PERMISSION_PATH = '/api/aishell/permission'

/**
 * Path for the posture new Sessions start in.
 *
 * A child of {@link PERMISSION_PATH}, registered separately: the fetch registry
 * matches whole paths rather than prefixes, so a posture request cannot land on
 * the conversation route by accident.
 */
export const PERMISSION_DEFAULT_PATH = `${PERMISSION_PATH}/default`

/** What this route needs: the plugin's own mode state. */
export interface PermissionRouteDeps {
  /** Whether a Session with this id is live. */
  readonly known: (session: SessionKey) => boolean
  /** Read one Session's mode. */
  readonly read: (session: SessionKey) => PermissionModeState
  /** Apply a Session's mode; returns the change so the browser can render it. */
  readonly write: (session: SessionKey, mode: PermissionMode) => PermissionModeChange
  /** The posture new Sessions start in. */
  readonly readDefault: () => PermissionMode
  /** Set the posture; returns the one it replaced. */
  readonly writeDefault: (mode: PermissionMode) => PermissionMode
}

/** A successful response: the mode now in effect. */
export interface PermissionStatus extends PermissionModeState {
  readonly ok: true
}

/**
 * A failed response.
 *
 * Still carries no `mode`: validation failures are the only remaining source,
 * but the rule stays — a request that could not be answered must not be
 * answered with a guess.
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

/** A Session id as this route accepts one: non-empty, and nothing more. */
function asSession(value: unknown): SessionKey | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined
}

/** The Session a GET names in its query string. */
function sessionOf(request: Request): SessionKey | undefined {
  return asSession(new URL(request.url, 'http://dsh.invalid').searchParams.get('session'))
}

/** A mode as this route accepts one from a request. */
function asMode(value: unknown): PermissionMode | undefined {
  return typeof value === 'string' && (PERMISSION_MODES as readonly string[]).includes(value)
    ? value as PermissionMode
    : undefined
}

/**
 * Report one Session's mode.
 *
 * @param deps - route collaborators.
 * @param request - the incoming GET; `session` names the conversation.
 */
export function handleGet(deps: PermissionRouteDeps, request: Request): Promise<Response> {
  const session = sessionOf(request)
  // Never inferred: answering without one would report the posture as if it
  // were this conversation's own mode, and a chip would render that as a
  // working switch over a decision nobody made here.
  if (session === undefined) {
    return Promise.resolve(json({ ok: false, error: 'session is required' }, 400))
  }
  // A Session that is not live owns no mode: the map is keyed by an identity
  // that only a live conversation has, and a stale id would otherwise answer
  // for a conversation nobody is looking at.
  if (!deps.known(session)) {
    return Promise.resolve(json({ ok: false, error: 'session is not live' }, 404))
  }
  return Promise.resolve(json({ ok: true, ...deps.read(session) } satisfies PermissionStatus))
}

/**
 * Apply one Session's mode.
 *
 * @param deps - route collaborators.
 * @param request - the incoming POST; its body carries `{ session, mode }`.
 */
export async function handleSet(deps: PermissionRouteDeps, request: Request): Promise<Response> {
  let body: unknown
  try {
    body = await request.json()
  } catch {
    return json({ ok: false, error: 'Request body is not valid JSON.' }, 400)
  }

  const fields = body as { session?: unknown, mode?: unknown } | null | undefined
  const session = asSession(fields?.session)
  if (session === undefined) {
    return json({ ok: false, error: 'session is required' }, 400)
  }
  // Checked before the mode: which conversation this is about decides whether
  // the request can be answered at all, and a complaint about the mode would
  // point the caller at the wrong field.
  //
  // The mode is stored under the Session id and released when that Session is
  // disposed, so the id has to name a live conversation: one that does not would
  // hold an entry nothing releases, and a later Session given the same id would
  // read a grant nobody made for it.
  if (!deps.known(session)) {
    return json({ ok: false, error: 'session is not live' }, 404)
  }
  const mode = asMode(fields?.mode)
  if (mode === undefined) {
    return json(
      { ok: false, error: `mode must be one of: ${PERMISSION_MODES.join(', ')}` },
      400,
    )
  }

  const change = deps.write(session, mode)
  return json({ ok: true, ...change })
}

/**
 * Report the posture new Sessions start in.
 *
 * @param deps - route collaborators.
 */
export function handleGetDefault(deps: PermissionRouteDeps): Promise<Response> {
  return Promise.resolve(json({ ok: true, mode: deps.readDefault() }))
}

/**
 * Set the posture new Sessions start in.
 *
 * @param deps - route collaborators.
 * @param request - the incoming POST; its body carries `{ mode }`.
 */
export async function handleSetDefault(deps: PermissionRouteDeps, request: Request): Promise<Response> {
  let body: unknown
  try {
    body = await request.json()
  } catch {
    return json({ ok: false, error: 'Request body is not valid JSON.' }, 400)
  }
  const mode = asMode((body as { mode?: unknown } | null | undefined)?.mode)
  if (mode === undefined) {
    return json(
      { ok: false, error: `mode must be one of: ${PERMISSION_MODES.join(', ')}` },
      400,
    )
  }
  return json({ ok: true, mode: deps.writeDefault(mode) })
}

/**
 * Build the route handlers.
 *
 * @param deps - route collaborators.
 * @returns handlers for the fetch registry.
 */
export function createPermissionRoutes(deps: PermissionRouteDeps): {
  get: (request: Request) => Promise<Response>
  set: (request: Request) => Promise<Response>
  getDefault: () => Promise<Response>
  setDefault: (request: Request) => Promise<Response>
} {
  return {
    get: (request: Request) => handleGet(deps, request),
    set: (request: Request) => handleSet(deps, request),
    getDefault: () => handleGetDefault(deps),
    setDefault: (request: Request) => handleSetDefault(deps, request),
  }
}