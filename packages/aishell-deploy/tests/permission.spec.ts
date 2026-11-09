/**
 * Browser-side permission route.
 *
 * The mode now lives in this process, so what matters here is narrower than
 * before — but two properties still carry weight:
 *
 *   1. A malformed request is rejected with a 4xx, not applied.
 *   2. A failure never carries a mode. The chip renders whatever comes back, so
 *      a rejected request must not look like "read-only is in effect": that
 *      would render as a working, locked-down switch when nothing was read.
 */

import { describe, it, expect, beforeEach } from 'vitest'

/** The mode the stub state holds. */
let mode: 'read_only' | 'read_write' = 'read_only'
/** Writes the route applied, in order. */
let writes: string[] = []

const { createPermissionRoutes, PERMISSION_PATH } = await import('../src/permission-route.ts')
const { PERMISSION_MODES } = await import('../src/permission.ts')

/** Route collaborators over a mutable module-state stub. */
function deps(): Parameters<typeof createPermissionRoutes>[0] {
  return {
    read: () => ({ mode, default: 'read_only', writable: mode === 'read_write' }),
    write: (next) => {
      const previous = mode
      mode = next
      writes.push(next)
      return { mode, previous, changed: previous !== next }
    },
  }
}

/** Build a POST carrying `body`. */
function post(body: unknown): Request {
  return new Request(`http://localhost${PERMISSION_PATH}`, {
    method: 'POST',
    body: typeof body === 'string' ? body : JSON.stringify(body),
  })
}

beforeEach(() => {
  mode = 'read_only'
  writes = []
})

describe('permission-route — GET', () => {
  it('returns the mode in effect', async () => {
    mode = 'read_write'
    const body = await (await createPermissionRoutes(deps()).get()).json() as Record<string, unknown>
    expect(body).toEqual({ ok: true, mode: 'read_write', default: 'read_only', writable: true })
  })

  it('reports writability from the mode, not from a separate flag', async () => {
    // `writable` is what the gate consults, so a route that computed it
    // independently would be able to disagree with the tool it describes.
    const readOnly = await (await createPermissionRoutes(deps()).get()).json() as Record<string, unknown>
    expect(readOnly.writable).toBe(false)

    mode = 'read_write'
    const writable = await (await createPermissionRoutes(deps()).get()).json() as Record<string, unknown>
    expect(writable.writable).toBe(true)
  })
})

describe('permission-route — POST', () => {
  it('applies a valid mode and reports the change', async () => {
    const response = await createPermissionRoutes(deps()).set(post({ mode: 'read_write' }))
    expect(response.status).toBe(200)
    const body = await response.json() as Record<string, unknown>
    expect(body).toEqual({ ok: true, mode: 'read_write', previous: 'read_only', changed: true })
    expect(writes).toEqual(['read_write'])
  })

  it('reports an unchanged mode honestly', async () => {
    mode = 'read_write'
    const body = await (await createPermissionRoutes(deps()).set(post({ mode: 'read_write' }))).json() as Record<string, unknown>
    expect(body.changed).toBe(false)
  })

  it('rejects an unknown mode without touching the state', async () => {
    const response = await createPermissionRoutes(deps()).set(post({ mode: 'read_mostly' }))
    expect(response.status).toBe(400)
    const body = await response.json() as Record<string, unknown>
    expect(body.ok).toBe(false)
    expect(String(body.error)).toContain(PERMISSION_MODES.join(', '))
    expect(writes).toEqual([])
    expect(mode).toBe('read_only')
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
    for (const body of [post({ mode: 'nope' }), post('{}')]) {
      const response = await createPermissionRoutes(deps()).set(body)
      const parsed = await response.json() as Record<string, unknown>
      expect(parsed).not.toHaveProperty('mode')
      expect(parsed).not.toHaveProperty('writable')
      expect(parsed).not.toHaveProperty('default')
    }
  })
})