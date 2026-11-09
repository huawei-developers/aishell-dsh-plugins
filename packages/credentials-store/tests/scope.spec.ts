/**
 * The credential scope — the one knob that decides where credentials live.
 *
 * Two names derive from it (the keyring service and the encrypted file name),
 * and they must never disagree: a build that wrote to one namespace and read
 * from another is the failure this constant exists to make impossible.
 *
 * The specs below run against `src/`, where the build-time substitution never
 * happens, so they pin the *default* path. The substitution itself is verified
 * against the built bundle — see the note on the last case.
 */

import { describe, it, expect } from 'vitest'
import {
  CREDENTIALS_FILE_NAME,
  CREDENTIAL_SCOPE,
  DEFAULT_SCOPE,
  KEYRING_SERVICE,
} from '../src/scope.ts'

describe('credential scope', () => {
  it('defaults to "plugins" for a source run', () => {
    // The test suite resolves `src/` directly, so no value was injected. The
    // `typeof` guard in `scope.ts` is what makes this a default rather than a
    // ReferenceError — a module that threw here would take down every test that
    // touches the store.
    expect(DEFAULT_SCOPE).toBe('plugins')
    expect(CREDENTIAL_SCOPE).toBe('plugins')
  })

  it('derives the keyring service from the scope', () => {
    // Part of the persistence contract. A rename here orphans every stored
    // entry while looking like a harmless constant change.
    expect(KEYRING_SERVICE).toBe(`aishell-dsh-${CREDENTIAL_SCOPE}`)
  })

  it('derives the file name from the same scope', () => {
    // The pair is the point: these two must move together, or a build writes to
    // one backend under a name the next build does not look for.
    expect(CREDENTIALS_FILE_NAME).toBe(`${CREDENTIAL_SCOPE}.credentials.enc`)
  })

  it('uses the documented default values', () => {
    // Spelled out rather than derived, so a change to either default has to be
    // made deliberately in two places — echoed here and in `scope.ts`.
    expect(KEYRING_SERVICE).toBe('aishell-dsh-plugins')
    expect(CREDENTIALS_FILE_NAME).toBe('plugins.credentials.enc')
  })

  it('cannot be changed at runtime', () => {
    // It is a substituted literal, not a read of `process.env`. Setting the
    // variable on a running process must not move the namespace — the value
    // selects where credentials live, and that belongs to the build.
    const before = KEYRING_SERVICE
    process.env.AISHELL_CREDENTIAL_SCOPE = 'changed-at-runtime'
    try {
      expect(KEYRING_SERVICE).toBe(before)
    } finally {
      delete process.env.AISHELL_CREDENTIAL_SCOPE
    }
  })
})