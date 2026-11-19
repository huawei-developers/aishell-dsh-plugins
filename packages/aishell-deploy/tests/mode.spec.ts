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
    // A restored Session announces `session/created` again; re-pinning it to a
    // posture that has since changed would silently widen it.
    pinSession('s1')
    setMode('s1', 'read_write')
    setDefaultPosture('read_only')
    pinSession('s1')

    expect(getMode('s1')).toBe('read_write')
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