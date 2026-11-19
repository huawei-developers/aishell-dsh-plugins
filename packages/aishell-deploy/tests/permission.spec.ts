/**
 * Browser-side permission route.
 *
 * Three properties carry the weight here:
 *
 *   1. A malformed request is rejected with a 4xx, not applied.
 *   2. A failure never carries a mode. The chip renders whatever comes back, so
 *      a rejected request must not look like "read-only is in effect": that
 *      would render as a working, locked-down switch when nothing was read.
 *   3. A request that names no Session is refused. The mode belongs to one
 *      conversation, and answering without one would apply a switch to
 *      conversations the caller was not looking at.
 */

import { describe, it, expect, beforeEach } from 'vitest'

/** Modes the stub holds, by Session. */
let modes = new Map<string, 'read_only' | 'read_write'>()
/** The posture new Sessions start in. */
let posture: 'read_only' | 'read_write' = 'read_only'
/** Writes the route applied, in order, as `session:mode`. */
let writes: string[] = []
/** Sessions the stub store holds. */
let live = new Set<string>()

const { createPermissionRoutes, PERMISSION_DEFAULT_PATH, PERMISSION_PATH } =
  await import('../src/permission-route.ts')
const { PERMISSION_MODES } = await import('../src/permission.ts')

/** The mode one Session is in, following the posture when it has none of its own. */
function modeOf(session: string): 'read_only' | 'read_write' {
  return modes.get(session) ?? posture
}

/** Route collaborators over a mutable module-state stub. */
function deps(): Parameters<typeof createPermissionRoutes>[0] {
  return {
    known: (session) => live.has(session),
    read: (session) => ({ mode: modeOf(session) }),
    write: (session, next) => {
      const previous = modeOf(session)
      modes.set(session, next)
      writes.push(`${session}:${next}`)
      return { mode: next, previous, changed: previous !== next }
    },
    readDefault: () => posture,
    writeDefault: (next) => {
      const previous = posture
      posture = next
      return previous
    },
  }
}

/** Build a GET naming `session`, or none when it is undefined. */
function get(session?: string): Request {
  const query = session === undefined ? '' : `?session=${encodeURIComponent(session)}`
  return new Request(`http://localhost${PERMISSION_PATH}${query}`, { method: 'GET' })
}

/** Build a POST carrying `body`, to `path` when given. */
function post(body: unknown, path = PERMISSION_PATH): Request {
  return new Request(`http://localhost${path}`, {
    method: 'POST',
    body: typeof body === 'string' ? body : JSON.stringify(body),
  })
}

beforeEach(() => {
  modes = new Map()
  posture = 'read_only'
  writes = []
  live = new Set(['s1', 's2'])
})

describe('permission-route — GET', () => {
  it('returns the mode one Session is in', async () => {
    modes.set('s1', 'read_write')
    const body = await (await createPermissionRoutes(deps()).get(get('s1'))).json() as Record<string, unknown>
    expect(body).toEqual({ ok: true, mode: 'read_write' })
  })

  it('answers the mode the gate consults, for each of them', async () => {
    // The chip renders this value as the state of the switch. Anything the
    // route derived separately from `getMode()` could disagree with the gate
    // the next tool call runs into.
    const readOnly = await (await createPermissionRoutes(deps()).get(get('s1'))).json() as Record<string, unknown>
    expect(readOnly.mode).toBe('read_only')

    modes.set('s1', 'read_write')
    const writable = await (await createPermissionRoutes(deps()).get(get('s1'))).json() as Record<string, unknown>
    expect(writable.mode).toBe('read_write')
  })

  it('answers each Session its own mode', async () => {
    // The failure a process-wide mode made: one conversation's grant reported
    // as another's state, so a chip showed write access nobody gave it.
    modes.set('s1', 'read_write')
    const routes = createPermissionRoutes(deps())
    const one = await (await routes.get(get('s1'))).json() as Record<string, unknown>
    const two = await (await routes.get(get('s2'))).json() as Record<string, unknown>
    expect(one.mode).toBe('read_write')
    expect(two.mode).toBe('read_only')
  })

  it('refuses a request that names no Session', async () => {
    // Never defaulted: an absent Session would otherwise be answered with the
    // posture, which a chip would render as this conversation's own switch.
    const response = await createPermissionRoutes(deps()).get(get())
    expect(response.status).toBe(400)
    const body = await response.json() as Record<string, unknown>
    expect(body).not.toHaveProperty('mode')
    expect(String(body.error)).toContain('session')
  })
})

describe('permission-route — POST', () => {
  it('applies a valid mode and reports the change', async () => {
    const response = await createPermissionRoutes(deps()).set(post({ session: 's1', mode: 'read_write' }))
    expect(response.status).toBe(200)
    const body = await response.json() as Record<string, unknown>
    expect(body).toEqual({ ok: true, mode: 'read_write', previous: 'read_only', changed: true })
    expect(writes).toEqual(['s1:read_write'])
  })

  it('reports an unchanged mode honestly', async () => {
    modes.set('s1', 'read_write')
    const body = await (await createPermissionRoutes(deps()).set(post({ session: 's1', mode: 'read_write' }))).json() as Record<string, unknown>
    expect(body.changed).toBe(false)
  })

  it('leaves every other Session alone', async () => {
    const routes = createPermissionRoutes(deps())
    await routes.set(post({ session: 's1', mode: 'read_write' }))
    const other = await (await routes.get(get('s2'))).json() as Record<string, unknown>
    expect(other.mode).toBe('read_only')
  })

  it('refuses a request that names no Session', async () => {
    const response = await createPermissionRoutes(deps()).set(post({ mode: 'read_write' }))
    expect(response.status).toBe(400)
    const body = await response.json() as Record<string, unknown>
    expect(body).not.toHaveProperty('mode')
    expect(writes).toEqual([])
    expect(modeOf('s1')).toBe('read_only')
  })

  it('rejects an unknown mode without touching the state', async () => {
    const response = await createPermissionRoutes(deps()).set(post({ session: 's1', mode: 'read_mostly' }))
    expect(response.status).toBe(400)
    const body = await response.json() as Record<string, unknown>
    expect(body.ok).toBe(false)
    expect(String(body.error)).toContain(PERMISSION_MODES.join(', '))
    expect(writes).toEqual([])
    expect(modeOf('s1')).toBe('read_only')
  })

  it('rejects a body that is not JSON', async () => {
    const response = await createPermissionRoutes(deps()).set(post('not json'))
    expect(response.status).toBe(400)
    expect(((await response.json()) as Record<string, unknown>).ok).toBe(false)
    expect(writes).toEqual([])
  })

  it('never answers a rejection with a mode', async () => {
    // The chip renders `mode` when present. A fabricated one would be a claim
    // about the gate that nothing verified.
    for (const body of [post({ session: 's1', mode: 'nope' }), post('{}'), post({ mode: 'read_write' })]) {
      const response = await createPermissionRoutes(deps()).set(body)
      const parsed = await response.json() as Record<string, unknown>
      expect(parsed).not.toHaveProperty('mode')
    }
  })
})

describe('permission-route — the posture', () => {
  it('reports and sets the posture new Sessions start in', async () => {
    const routes = createPermissionRoutes(deps())

    const before = await (await routes.getDefault()).json() as Record<string, unknown>
    expect(before).toEqual({ ok: true, mode: 'read_only' })

    const response = await routes.setDefault(post({ mode: 'read_write' }, PERMISSION_DEFAULT_PATH))
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ ok: true, mode: 'read_only' })
    expect(posture).toBe('read_write')

    const after = await (await routes.getDefault()).json() as Record<string, unknown>
    expect(after.mode).toBe('read_write')
  })

  it('does not reach into a Session that already exists', async () => {
    // A deployment setting is what the NEXT Session starts in. Widening a
    // conversation already on screen would do it with nobody at that console
    // asking, which is the thing per-Session modes exist to prevent. The
    // existing Session here is one that has never switched, so its answer is
    // the posture it was created under rather than anything it chose.
    const routes = createPermissionRoutes(deps())
    await routes.set(post({ session: 's1', mode: 'read_only' }))

    await routes.setDefault(post({ mode: 'read_write' }, PERMISSION_DEFAULT_PATH))

    const existing = await (await routes.get(get('s1'))).json() as Record<string, unknown>
    const fresh = await (await routes.get(get('s2'))).json() as Record<string, unknown>
    expect(existing.mode).toBe('read_only')
    expect(fresh.mode).toBe('read_write')
  })

  it('rejects an unknown mode', async () => {
    const response = await createPermissionRoutes(deps())
      .setDefault(post({ mode: 'write-only' }, PERMISSION_DEFAULT_PATH))
    expect(response.status).toBe(400)
    expect(((await response.json()) as Record<string, unknown>).ok).toBe(false)
    expect(posture).toBe('read_only')
  })
})
describe('permission-route — a Session the store does not hold', () => {
  it('refuses to record a mode under an unknown id', async () => {
    // The map is keyed by Session id and only a disposal removes an entry, so
    // an id with no conversation behind it would persist — and a future Session
    // reusing it would inherit a grant nobody gave.
    const response = await createPermissionRoutes(deps()).set(post({ session: 'not-live', mode: 'read_write' }))
    expect(response.status).toBe(404)
    expect(((await response.json()) as Record<string, unknown>).ok).toBe(false)
    expect(writes).toEqual([])
    expect(modeOf('not-live')).toBe('read_only')
  })

  it('refuses to answer for an unknown id', async () => {
    const response = await createPermissionRoutes(deps()).get(get('not-live'))
    expect(response.status).toBe(404)
    expect(await response.json()).not.toHaveProperty('mode')
  })
})

describe('permission-route — which complaint comes first', () => {
  it('names the Session before the mode when both are wrong', () => {
    // The conversation decides whether the request can be answered at all; a
    // complaint about the mode would point the caller at the wrong field.
    return createPermissionRoutes(deps())
      .set(post({ session: 'not-live', mode: 'nope' }))
      .then(async (response) => {
        expect(response.status).toBe(404)
        expect(String(((await response.json()) as Record<string, unknown>).error)).toContain('session')
      })
  })
})
