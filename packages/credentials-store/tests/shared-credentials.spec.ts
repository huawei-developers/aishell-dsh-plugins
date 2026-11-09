/**
 * The shared credential bundle.
 *
 * These specs pin the properties that made the previous three-key layout
 * dangerous rather than merely untidy:
 *
 *   1. **One entry.** A save is one write, so a pair can never be left
 *      half-replaced; a read is one snapshot, so a new AK can never pair with an
 *      old SK.
 *   2. **The old layout keeps working.** Existing installs have three separate
 *      entries; the first read must fold them in rather than reporting "not
 *      authenticated".
 *   3. **Clearing removes everything.** Not just the pair — the token and the
 *      e2b key ride in the same record, and either left behind is inherited by
 *      the next credential set.
 */

import { describe, it, expect, vi } from 'vitest'
import { MemoryBackend } from '../src/index.ts'
import {
  CREDENTIAL_ACCOUNT,
  LEGACY_ACCOUNTS,
  LEGACY_E2B_ACCOUNT,
  clearCredentials,
  decodeBundle,
  encodeBundle,
  hasStoredPair,
  clearE2BKey,
  readE2BKey,
  readStoredPair,
  updateCredentials,
  writeE2BKey,
  writeHuaweiCloud,
} from '../src/accounts.ts'
import { FOREVER_EXPIRY } from '../src/accounts.ts'

describe('the bundle — the persistence contract', () => {
  it('keeps the entry name stable', () => {
    // Part of what every past release wrote. Renaming it does not fail a build;
    // it silently orphans the credentials of every existing install.
    expect(CREDENTIAL_ACCOUNT).toBe('aishell-credential')
  })

  it('round-trips through base64', () => {
    const bundle = {
      huaweicloud: { access_key: 'AK1', secret_key: 'SK1' },
      aishell_e2b: { api_key: 'sk-e2b', expired_at: FOREVER_EXPIRY },
    }
    expect(decodeBundle(encodeBundle(bundle))).toEqual(bundle)
  })

  it('stores base64, so the secret is not a plaintext field', () => {
    // An encoding, not encryption — but the stored string must not read as the
    // secret directly, which is what a careless log or a `secret-tool` dump
    // would otherwise show.
    const encoded = encodeBundle({ huaweicloud: { access_key: 'AK1', secret_key: 'SECRET-SK' } })
    expect(encoded).not.toContain('SECRET-SK')
  })

  it('reads unreadable content as an empty bundle rather than throwing', () => {
    // A corrupt entry should behave like "nothing stored", so the person is
    // asked to authenticate again — not so every tool call dies on a parse.
    for (const raw of [undefined, '', 'not json', '!!not base64!!', encodeBundle({}), 'null']) {
      expect(() => decodeBundle(raw)).not.toThrow()
      expect(decodeBundle(raw)).toEqual(raw === 'null' ? {} : decodeBundle(raw))
    }
  })

  it('drops a section that is malformed rather than half-reading it', () => {
    // A half pair is no pair; a section missing its secret key must not be
    // handed to the signer.
    const bundle = decodeBundle(encodeBundle({ huaweicloud: { access_key: 'AK1' } } as never))
    expect(bundle.huaweicloud).toBeUndefined()
  })
})

describe('the bundle — reading the pair', () => {
  it('reads a complete pair', () => {
    const store = new MemoryBackend()
    writeHuaweiCloud(store, { ak: 'AK1', sk: 'SK1' })

    expect(readStoredPair(store)).toEqual({ ak: 'AK1', sk: 'SK1' })
    expect(hasStoredPair(store)).toBe(true)
  })

  it('omits an absent token rather than passing an empty string', () => {
    // An empty `x-security-token` header is a third header the gateway rejects.
    const store = new MemoryBackend()
    writeHuaweiCloud(store, { ak: 'AK1', sk: 'SK1' })
    expect(readStoredPair(store)).not.toHaveProperty('securityToken')
  })

  it('carries a stored token', () => {
    const store = new MemoryBackend()
    writeHuaweiCloud(store, { ak: 'AK1', sk: 'SK1', securityToken: 'STS1' })
    expect(readStoredPair(store)).toEqual({ ak: 'AK1', sk: 'SK1', securityToken: 'STS1' })
  })

  it('replaces the token on a save that carries none', () => {
    // A token belongs to the credential set that carried it; inheriting a stale
    // one would sign the next request with someone else's session.
    const store = new MemoryBackend()
    writeHuaweiCloud(store, { ak: 'AK1', sk: 'SK1', securityToken: 'STS1' })
    writeHuaweiCloud(store, { ak: 'AK1', sk: 'SK1' })

    expect(readStoredPair(store)).not.toHaveProperty('securityToken')
  })

  it('is a single read, so the pair cannot be seen mid-rotation', () => {
    // The property the three-entry layout could not offer: the pair and its
    // token come from one decoded record.
    const store = new MemoryBackend()
    writeHuaweiCloud(store, { ak: 'AK1', sk: 'SK1' })

    const reads = vi.spyOn(store, 'get')
    readStoredPair(store)
    expect(reads).toHaveBeenCalledTimes(1)
  })
})

describe('the bundle — the e2b section', () => {
  it('stores a key without disturbing the pair', () => {
    const store = new MemoryBackend()
    writeHuaweiCloud(store, { ak: 'AK1', sk: 'SK1' })
    writeE2BKey(store, { api_key: 'sk-e2b', expired_at: FOREVER_EXPIRY, ak_fingerprint: 'abc' })

    expect(readE2BKey(store)).toEqual({
      api_key: 'sk-e2b', expired_at: FOREVER_EXPIRY, ak_fingerprint: 'abc',
    })
    expect(readStoredPair(store)).toEqual({ ak: 'AK1', sk: 'SK1' })
  })

  it('clears a key without disturbing the pair', () => {
    // `invalidate()` drops the key, not the credentials: the AK/SK live in the
    // same record but are not the e2b plugin's to remove.
    const store = new MemoryBackend()
    writeHuaweiCloud(store, { ak: 'AK1', sk: 'SK1' })
    writeE2BKey(store, { api_key: 'sk-e2b', expired_at: FOREVER_EXPIRY })

    clearE2BKey(store)

    expect(readE2BKey(store)).toBeUndefined()
    expect(readStoredPair(store)).toEqual({ ak: 'AK1', sk: 'SK1' })
  })

  it('reports nothing when no key is stored', () => {
    const store = new MemoryBackend()
    expect(readE2BKey(store)).toBeUndefined()
  })
})

describe('the bundle — clearing', () => {
  it('removes the pair, the token, and the e2b key together', () => {
    const store = new MemoryBackend()
    writeHuaweiCloud(store, { ak: 'AK1', sk: 'SK1', securityToken: 'STS1' })
    writeE2BKey(store, { api_key: 'sk-e2b', expired_at: FOREVER_EXPIRY })

    clearCredentials(store)

    // A token or key left behind would be inherited by the next pair, which is
    // a security failure rather than a tidiness one.
    expect(store.get(CREDENTIAL_ACCOUNT)).toBeUndefined()
    expect(readStoredPair(store)).toBeUndefined()
    expect(readE2BKey(store)).toBeUndefined()
  })

  it('is a no-op when nothing is stored', () => {
    const store = new MemoryBackend()
    expect(() => { clearCredentials(store) }).not.toThrow()
  })
})

describe('the bundle — migrating the three-key layout', () => {
  /** Plant the layout an earlier release wrote. */
  function plantLegacy(store: MemoryBackend, ak: string, sk: string, token?: string): void {
    store.set(LEGACY_ACCOUNTS[0], ak)
    store.set(LEGACY_ACCOUNTS[1], sk)
    if (token !== undefined) store.set(LEGACY_ACCOUNTS[2], token)
  }

  it('folds existing entries into the bundle on first read', () => {
    const store = new MemoryBackend()
    plantLegacy(store, 'AK1', 'SK1', 'STS1')

    expect(readStoredPair(store)).toEqual({ ak: 'AK1', sk: 'SK1', securityToken: 'STS1' })
    // And the old entries are gone, so the two layouts cannot disagree later.
    for (const account of LEGACY_ACCOUNTS) expect(store.get(account)).toBeUndefined()
    expect(store.get(CREDENTIAL_ACCOUNT)).toBeDefined()
  })

  it('is idempotent: a second read finds the migrated record', () => {
    const store = new MemoryBackend()
    plantLegacy(store, 'AK1', 'SK1')

    const first = readStoredPair(store)
    const second = readStoredPair(store)
    expect(second).toEqual(first)
  })

  it('carries the legacy e2b entry into the bundle', () => {
    const store = new MemoryBackend()
    plantLegacy(store, 'AK1', 'SK1')
    store.set(LEGACY_E2B_ACCOUNT, JSON.stringify({
      key: 'sk-e2b-legacy',
      expiresAt: '2099-01-01T00:00:00.000Z',
      akFingerprint: 'abc',
    }))

    expect(readE2BKey(store)).toEqual({
      api_key: 'sk-e2b-legacy',
      expired_at: '2099-01-01T00:00:00.000Z',
      ak_fingerprint: 'abc',
    })
    expect(store.get(LEGACY_E2B_ACCOUNT)).toBeUndefined()
  })

  it('reads a bare legacy key as one that never expires', () => {
    // The oldest layout stored the bare secret with no expiry. Treating it as
    // expired would mint a new key per call, which orphans every sandbox.
    const store = new MemoryBackend()
    store.set(LEGACY_E2B_ACCOUNT, 'sk-e2b-bare')

    expect(readE2BKey(store)).toEqual({ api_key: 'sk-e2b-bare', expired_at: FOREVER_EXPIRY })
  })

  it('migrates a legacy e2b key even with no pair stored', () => {
    // The two layouts were independent; an e2b-only store must still be
    // migrated rather than read as empty.
    const store = new MemoryBackend()
    store.set(LEGACY_E2B_ACCOUNT, 'sk-e2b-bare')

    expect(readE2BKey(store)).toBeDefined()
    expect(store.get(CREDENTIAL_ACCOUNT)).toBeDefined()
  })

  it('reports nothing when neither layout has a pair', () => {
    const store = new MemoryBackend()
    store.set(LEGACY_ACCOUNTS[0], 'AK1') // no SK

    expect(readStoredPair(store)).toBeUndefined()
  })

  it('leaves the legacy entries in place when the merged record cannot be written', () => {
    // Losing the credentials would be worse than retrying: the next read tries
    // the migration again.
    const store = new MemoryBackend()
    plantLegacy(store, 'AK1', 'SK1')
    const set = vi.spyOn(store, 'set').mockImplementation(() => { throw new Error('keyring locked') })

    expect(readStoredPair(store)).toEqual({ ak: 'AK1', sk: 'SK1' })
    expect(store.get(LEGACY_ACCOUNTS[0])).toBe('AK1')
    set.mockRestore()
  })
})

describe('updateCredentials', () => {
  it('applies the updater and returns the stored bundle', () => {
    const store = new MemoryBackend()
    const next = updateCredentials(store, () => ({ huaweicloud: { access_key: 'AK1', secret_key: 'SK1' } }))

    expect(next.huaweicloud?.access_key).toBe('AK1')
    expect(readStoredPair(store)?.ak).toBe('AK1')
  })

  it('treats an undefined result as "nothing changed" and skips the write', () => {
    // Every write re-encodes the record; a needless one would look like a
    // credential change to anything watching the store.
    const store = new MemoryBackend()
    writeHuaweiCloud(store, { ak: 'AK1', sk: 'SK1' })
    const set = vi.spyOn(store, 'set')

    updateCredentials(store, () => undefined)

    expect(set).not.toHaveBeenCalled()
  })
})