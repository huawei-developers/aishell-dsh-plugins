/**
 * Permission changes reach the audit service.
 *
 * What these pin: every real change is recorded, a re-assertion of the mode
 * already in force is not, the record names the Session it applies to and the
 * direction of the change, and a deployment without the audit plugin still
 * switches modes.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

const modeModule = await import('../src/permission/mode.ts')
const { installPermissionRecorder } = modeModule

// The real plugin, so the composition test drives `apply()` rather than a
// reimplementation of the wiring it is meant to check.
const { apply: applyDeploy } = await import('../src/index.ts')

beforeEach(() => {
  // A recorder left installed by one case would observe the next one's changes.
  installPermissionRecorder(undefined)
  modeModule.resetMode()
})

describe('permission changes — the recorder', () => {
  it('records a real change with its direction and source', () => {
    const changes: unknown[] = []
    installPermissionRecorder(change => { changes.push(change) })

    modeModule.setMode('s1', 'read_write')
    expect(changes).toEqual([{ session: 's1', previous: 'read_only', mode: 'read_write', actor: 'user' }])
  })

  it('does not record a re-assertion of the mode already in force', () => {
    // The chip re-reads the state after every call. Recording those would fill
    // the trail with entries for actions nobody took.
    const changes: unknown[] = []
    installPermissionRecorder(change => { changes.push(change) })
    modeModule.setMode('s1', 'read_write')

    modeModule.setMode('s1', 'read_write')
    expect(changes).toHaveLength(1)
  })

  it('records each Session on its own', () => {
    const changes: unknown[] = []
    installPermissionRecorder(change => { changes.push(change) })

    modeModule.setMode('s1', 'read_write')
    modeModule.setMode('s2', 'read_write')

    expect(changes).toHaveLength(2)
    expect(modeModule.getMode('s1')).toBe('read_write')
    expect(modeModule.getMode('s2')).toBe('read_write')
  })

  it('does not record a reset', () => {
    // `resetMode` restores the state the module initialised with rather than
    // changing what the process enforces, so there is nothing for a trail to
    // say about it.
    const changes: unknown[] = []
    installPermissionRecorder(change => { changes.push(change) })
    modeModule.setMode('s1', 'read_write')

    modeModule.resetMode()
    expect(changes).toHaveLength(1)
    expect(modeModule.getMode('s1')).toBe('read_only')
  })

  it('switches modes with no recorder installed', () => {
    // `setMode` runs before the plugin is applied and in every test that never
    // installs one. Neither is a reason for a switch to fail.
    expect(() => modeModule.setMode('s1', 'read_write')).not.toThrow()
    expect(modeModule.getMode('s1')).toBe('read_write')
  })

  it('stops observing once the recorder is disposed', () => {
    const seen = vi.fn()
    const dispose = installPermissionRecorder(seen)
    dispose()
    modeModule.setMode('s1', 'read_write')
    expect(seen).not.toHaveBeenCalled()
  })
})

describe('permission changes — the audit record', () => {
  it('names the direction, so a grant and its reversal are distinguishable', () => {
    // Both would otherwise read `outcome=granted`, leaving an auditor to know
    // the mode vocabulary to tell which way a switch went.
    const records: Array<{ outcome: string }> = []
    installPermissionRecorder((change) => {
      records.push({ outcome: change.mode === 'read_write' ? 'granted' : 'revoked' })
    })
    modeModule.setMode('s1', 'read_write')
    modeModule.setMode('s1', 'read_only')
    expect(records.map(r => r.outcome)).toEqual(['granted', 'revoked'])
  })
})

describe('permission changes — plugin composition', () => {
  it('records a switch made before the audit plugin has loaded', async () => {
    // The base bundle places `aishell-audit` after this plugin, so the service
    // does not exist when `apply()` runs. `ctx.inject` is what defers the
    // install until it does; a recorder read at mount time would find nothing
    // and every switch would go unrecorded while the wiring looked complete.
    const seen: Array<Record<string, unknown>> = []
    const audit = { record: (event: Record<string, unknown>) => { seen.push(event) } }

    let pending: ((child: unknown) => void) | undefined
    const ctx = {
      logger: () => ({ info: () => {}, warn: () => {}, error: () => {} }),
      effect: (effect: () => (() => void)) => { effect() },
      get: () => undefined,
      on: () => () => {},
      tools: { get: () => undefined, register: () => () => {} },
      connection: { fetch: { register: () => () => {} } },
      sessions: { list: () => [] },
      // Cordis holds the callback until the service exists, which is what this
      // test reproduces: the body runs only when the test says so.
      inject: (deps: string[], callback: (child: unknown) => void) => {
        if (deps.includes('audit')) pending = callback
      },
    }

    applyDeploy(ctx as never, {
      defaultRegion: { get: () => undefined },
      toolCallTimeoutMs: { get: () => 600_000 },
      startupPosture: 'read_only',
    } as never)
    expect(pending).toBeDefined()

    // Before the audit plugin loads, a switch is accepted and recorded nowhere.
    modeModule.setMode('s1', 'read_write')
    expect(seen).toHaveLength(0)

    // The service arrives; the deferred body runs and the trail is live.
    pending!({
      audit,
      effect: (effect: () => (() => void)) => { effect() },
    })
    // The posture new Sessions start in, and nothing about the switch made
    // while the trail was absent: crediting that switch to the startup would
    // misdescribe it.
    expect(seen).toHaveLength(1)
    expect(seen[0]).toMatchObject({ outcome: 'revoked', actor: 'startup', detail: { to: 'read_only' } })

    modeModule.setMode('s1', 'read_only')
    // The switch the person made, from the mode the gate was enforcing.
    expect(seen).toHaveLength(2)
    expect(seen[1]).toMatchObject({
      outcome: 'revoked', actor: 'user', detail: { from: 'read_write', to: 'read_only', session: 's1' },
    })
  })

  it('records the posture the process started in, not the one in force when the trail opens', () => {
    // The audit service can arrive after a switch has been accepted. The
    // startup entry describes the value the process started with, so reading
    // the posture at record time would write that switch down as the start —
    // and the trail could no longer tell a watched start from an unwatched one.
    const seen: Array<Record<string, unknown>> = []
    const audit = { record: (event: Record<string, unknown>) => { seen.push(event) } }

    let pending: ((child: unknown) => void) | undefined
    const ctx = {
      logger: () => ({ info: () => {}, warn: () => {}, error: () => {} }),
      effect: (effect: () => (() => void)) => { effect() },
      get: () => undefined,
      on: () => () => {},
      tools: { get: () => undefined, register: () => () => {} },
      connection: { fetch: { register: () => () => {} } },
      sessions: { list: () => [] },
      inject: (deps: string[], callback: (child: unknown) => void) => {
        if (deps.includes('audit')) pending = callback
      },
    }

    applyDeploy(ctx as never, {
      defaultRegion: { get: () => undefined },
      toolCallTimeoutMs: { get: () => 600_000 },
      startupPosture: 'read_only',
    } as never)

    // A switch lands before the service exists.
    modeModule.setDefaultPosture('read_write')

    pending!({ audit, effect: (effect: () => (() => void)) => { effect() } })

    expect(seen).toHaveLength(1)
    expect(seen[0]).toMatchObject({ outcome: 'revoked', actor: 'startup', detail: { to: 'read_only' } })
  })

  it('records the posture the process started in', () => {
    // Every process starts read-only, and the trail says so before any switch:
    // a log whose first entry is a user's weakening of that posture cannot be
    // told from one where nobody was watching before it.
    const seen: Array<Record<string, unknown>> = []
    const audit = { record: (event: Record<string, unknown>) => { seen.push(event) } }

    let pending: ((child: unknown) => void) | undefined
    const ctx = {
      logger: () => ({ info: () => {}, warn: () => {}, error: () => {} }),
      effect: (effect: () => (() => void)) => { effect() },
      get: () => undefined,
      on: () => () => {},
      tools: { get: () => undefined, register: () => () => {} },
      connection: { fetch: { register: () => () => {} } },
      sessions: { list: () => [] },
      inject: (deps: string[], callback: (child: unknown) => void) => {
        if (deps.includes('audit')) pending = callback
      },
    }

    applyDeploy(ctx as never, {
      defaultRegion: { get: () => undefined },
      toolCallTimeoutMs: { get: () => 600_000 },
      startupPosture: 'read_only',
    } as never)
    pending!({ audit, effect: (effect: () => (() => void)) => { effect() } })

    expect(seen).toHaveLength(1)
    // No `from`: the process started here, so there was no transition. And no
    // `session`: the record describes what new conversations start in.
    expect(seen[0]).toMatchObject({ outcome: 'revoked', actor: 'startup', detail: { to: 'read_only' } })
    const detail = seen[0]!.detail as Record<string, unknown>
    expect(detail).not.toHaveProperty('from')
    expect(detail).not.toHaveProperty('session')
  })
})
describe('permission changes — a failing audit', () => {
  it('does not fail the switch it describes', () => {
    // The switch is the decision; the record describes it. A trail that could
    // veto the decision would turn a broken audit sink into a permission change
    // that silently did not take effect.
    const audit = { record: () => { throw new Error('disk full') } }

    let pending: ((child: unknown) => void) | undefined
    const ctx = {
      logger: () => ({ info: () => {}, warn: () => {}, error: () => {} }),
      effect: (effect: () => (() => void)) => { effect() },
      get: () => undefined,
      on: () => () => {},
      tools: { get: () => undefined, register: () => () => {} },
      connection: { fetch: { register: () => () => {} } },
      sessions: { list: () => [] },
      inject: (deps: string[], callback: (child: unknown) => void) => {
        if (deps.includes('audit')) pending = callback
      },
    }

    applyDeploy(ctx as never, {
      defaultRegion: { get: () => undefined },
      toolCallTimeoutMs: { get: () => 600_000 },
      startupPosture: 'read_only',
    } as never)
    expect(() => pending!({ audit, effect: (effect: () => (() => void)) => { effect() } })).not.toThrow()

    expect(() => modeModule.setMode('s1', 'read_write')).not.toThrow()
    expect(modeModule.getMode('s1')).toBe('read_write')
  })
})
