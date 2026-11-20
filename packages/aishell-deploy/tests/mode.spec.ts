/**
 * The per-Session mode, and the posture new Sessions start in.
 *
 * What these pin is the pair of rules that make "per Session" mean something:
 * a switch reaches one conversation, and a posture change reaches none of the
 * ones already on screen. The second rule depends on every Session carrying an
 * entry of its own, which is what keeps it distinct from a fallback to the
 * posture.
 */

import { describe, it, expect, beforeEach } from 'vitest'

import {
  applyStartupPosture,
  defaultPosture,
  forgetSession,
  getMode,
  installPermissionRecorder,
  pinSession,
  resetMode,
  setDefaultPosture,
  setMode,
  writesAllowed,
} from '../src/permission/mode.ts'

beforeEach(() => {
  installPermissionRecorder(undefined)
  resetMode()
})

describe('mode — one Session at a time', () => {
  it('starts a new Session in the posture', () => {
    pinSession('s1')
    expect(getMode('s1')).toBe('read_only')
  })

  it('switches one Session without touching another', () => {
    pinSession('s1')
    pinSession('s2')

    setMode('s1', 'read_write')

    expect(getMode('s1')).toBe('read_write')
    expect(getMode('s2')).toBe('read_only')
    expect(writesAllowed('s1')).toBe(true)
    expect(writesAllowed('s2')).toBe(false)
  })

  it('treats a call with no Session as the posture', () => {
    // A tool call outside an agent answers with the posture — it is not a
    // separate policy, so a deployment that raised the posture raised this too.
    expect(getMode(undefined)).toBe('read_only')
    expect(writesAllowed(undefined)).toBe(false)

    setDefaultPosture('read_write')
    expect(getMode(undefined)).toBe('read_write')
    expect(writesAllowed(undefined)).toBe(true)
  })
})

describe('mode — the posture is not retroactive', () => {
  it('leaves an existing Session pinned to what it was created with', () => {
    // The failure: a Session with no entry follows `posture`, so a deployment
    // raising the posture would widen a conversation already on screen.
    pinSession('existing')
    setDefaultPosture('read_write')

    expect(getMode('existing')).toBe('read_only')
  })

  it('gives a Session created after the change the new posture', () => {
    setDefaultPosture('read_write')
    pinSession('fresh')

    expect(getMode('fresh')).toBe('read_write')
  })

  it('holds a Session that switched back to read-only against a later posture', () => {
    // Switching back to the value the posture happens to have must not turn the
    // Session into a follower: its own answer is what the conversation has.
    pinSession('s1')
    setMode('s1', 'read_write')
    setMode('s1', 'read_only')
    setDefaultPosture('read_write')

    expect(getMode('s1')).toBe('read_only')
  })
})

describe('mode — lifetime', () => {
  it('forgets a disposed Session', () => {
    pinSession('s1')
    setMode('s1', 'read_write')
    forgetSession('s1')

    expect(getMode('s1')).toBe('read_only')
  })

  it('pins a Session once, not again on a re-entry', () => {
    // Within one run a Session keeps the answer it was given: a posture change
    // followed by another `pinSession` for the same id leaves its own entry
    // alone.
    pinSession('s1')
    setMode('s1', 'read_write')
    setDefaultPosture('read_only')
    pinSession('s1')

    expect(getMode('s1')).toBe('read_write')
  })

  it('takes the new posture for a Session restored into a new run', () => {
    // A restart clears every entry — the map lives in the process. A restored
    // conversation re-enters with none and is pinned to the posture the new
    // process started with, so a deployment's `startupPosture` decides what a
    // reopened conversation begins in.
    pinSession('s1')
    setMode('s1', 'read_write')

    resetMode()
    applyStartupPosture('read_only')
    pinSession('s1')

    expect(getMode('s1')).toBe('read_only')
  })

  it('restores the startup state on reset, entries included', () => {
    pinSession('s1')
    setMode('s1', 'read_write')
    setDefaultPosture('read_write')

    resetMode()

    expect(defaultPosture()).toBe('read_only')
    expect(getMode('s1')).toBe('read_only')
  })
})

describe('mode — the posture a deployment declares', () => {
  it('answers the declared posture before anything is switched', () => {
    applyStartupPosture('read_write')

    expect(defaultPosture()).toBe('read_write')
    expect(getMode(undefined)).toBe('read_write')
  })

  it('pins a Session created under the declared posture', () => {
    applyStartupPosture('read_write')
    pinSession('fresh')

    expect(getMode('fresh')).toBe('read_write')
  })

  it('is replaced by a running override, and restored by the next start', () => {
    // The override is the switch a person makes; the declared posture is what
    // the deployment says. A start re-applies the latter, so the override
    // covers one process and the declaration covers every start.
    applyStartupPosture('read_write')
    setDefaultPosture('read_only')
    expect(defaultPosture()).toBe('read_only')

    applyStartupPosture('read_write')
    expect(defaultPosture()).toBe('read_write')
  })

  it('pins a Session once the declared posture is applied, not to the default', () => {
    // The order the plugin applies these in is the posture's definition: the
    // declared value is in place before anything is pinned, so a Session that
    // was open at mount starts under it.
    applyStartupPosture('read_write')
    pinSession('pre-existing')

    expect(getMode('pre-existing')).toBe('read_write')
  })
})