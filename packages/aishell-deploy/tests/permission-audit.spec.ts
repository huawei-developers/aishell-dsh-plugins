/**
 * Permission changes reach the audit service.
 *
 * What these pin: every real change is recorded, a re-assertion of the current
 * mode is not, the record carries the account and the direction of the change,
 * and a deployment without the audit plugin still switches modes.
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

    modeModule.setMode('read_write')
    expect(changes).toEqual([{ previous: 'read_only', mode: 'read_write', actor: 'user' }])
  })

  it('does not record a re-assertion of the mode already in force', () => {
    // The chip re-reads the state after every call. Recording those would fill
    // the trail with entries for actions nobody took.
    const changes: unknown[] = []
    installPermissionRecorder(change => { changes.push(change) })
    modeModule.setMode('read_write')

    modeModule.setMode('read_write')
    expect(changes).toHaveLength(1)
  })

  it('does not record a reset', () => {
    // `resetMode` restores the state the module initialised with rather than
    // changing what the process enforces, so there is nothing for a trail to
    // say about it.
    const changes: unknown[] = []
    installPermissionRecorder(change => { changes.push(change) })
    modeModule.setMode('read_write')

    modeModule.resetMode()
    expect(changes).toHaveLength(1)
    expect(modeModule.getMode()).toBe('read_only')
  })

  it('switches modes with no recorder installed', () => {
    // `setMode` runs before the plugin is applied and in every test that never
    // installs one. Neither is a reason for a switch to fail.
    expect(() => modeModule.setMode('read_write')).not.toThrow()
    expect(modeModule.getMode()).toBe('read_write')
  })

  it('stops observing once the recorder is disposed', () => {
    const seen = vi.fn()
    const dispose = installPermissionRecorder(seen)
    dispose()
    modeModule.setMode('read_write')
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
    modeModule.setMode('read_write')
    modeModule.setMode('read_only')
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
      // Cordis holds the callback until the service exists, which is what this
      // test reproduces: the body runs only when the test says so.
      inject: (deps: string[], callback: (child: unknown) => void) => {
        if (deps.includes('audit')) pending = callback
      },
    }

    applyDeploy(ctx as never, {
      defaultRegion: { get: () => undefined },
      toolCallTimeoutMs: { get: () => 600_000 },
    } as never)
    expect(pending).toBeDefined()

    // Before the audit plugin loads, a switch is accepted and recorded nowhere.
    modeModule.setMode('read_write')
    expect(seen).toHaveLength(0)

    // The service arrives; the deferred body runs and the trail is live.
    pending!({
      audit,
      effect: (effect: () => (() => void)) => { effect() },
    })
    modeModule.setMode('read_only')
    // One record: the switch the person made. The process STARTED in read_only,
    // so there was no configuration grant to report — the grant the user made
    // was theirs, and crediting the configuration with it would be wrong.
    expect(seen).toHaveLength(1)
    expect(seen[0]).toMatchObject({ outcome: 'revoked', actor: 'user', detail: { from: 'read_write', to: 'read_only' } })
  })

  it('reports a startup grant it was configured with, and only that', () => {
    // The other half: when the CONFIGURATION granted write access, the trail
    // has to say so, because nothing else in the log would.
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
      inject: (deps: string[], callback: (child: unknown) => void) => {
        if (deps.includes('audit')) pending = callback
      },
    }

    // `mode.ts` pins the startup mode at load, so a test process cannot change
    // it by editing the environment. What this exercises is the plugin's rule:
    // report the startup grant when the CONFIGURED mode grants write access.
    // The stub below puts the module in that state, which is what a process
    // launched with `HW_DEFAULT_PERMISSION=read_write` is in.
    const startupMode = vi.spyOn(modeModule, 'defaultMode').mockReturnValue('read_write')

    try {
      applyDeploy(ctx as never, {
        defaultRegion: { get: () => undefined },
        toolCallTimeoutMs: { get: () => 600_000 },
      } as never)
      pending!({ audit, effect: (effect: () => (() => void)) => { effect() } })

      expect(seen).toHaveLength(1)
      // No `from`: the process started here, so there was no transition.
      expect(seen[0]).toMatchObject({ outcome: 'granted', actor: 'startup', detail: { to: 'read_write' } })
      expect(seen[0]!.detail as Record<string, unknown>).not.toHaveProperty('from')
    } finally {
      startupMode.mockRestore()
    }
  })
})
