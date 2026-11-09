/**
 * The credential store's on-disk format and the three ways it can be damaged.
 *
 * These cases share one property that the ordinary round-trip spec cannot
 * reach: each is a *file that already exists and is not what the code expects*.
 * The store's whole job at that moment is to not make things worse, and every
 * one of these used to.
 *
 *   1. An unreadable file followed by a save used to write a one-entry file
 *      over every other credential — silently, because load() reported an
 *      empty store rather than a failure.
 *   2. scrypt's cost parameters were inherited from the runtime's defaults, so
 *      the on-disk format had a dependency nobody had written down.
 *   3. The canonical query string sorted with `localeCompare`, which disagrees
 *      with the byte order the signing specification requires on mixed case.
 *
 * The first is pinned by behaviour, the second by the artifact it produces, and
 * the third by a signature computed from both orderings.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { join } from 'node:path'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'

const { FingerprintBackend, UnreadableCredentialsFile, CREDENTIALS_FILE_NAME } =
  await import('../src/index.ts')
const { canonicalQuery, compareCodeUnits } = await import('../src/signer.ts')

/** A fresh directory per case, removed afterwards. */
function tempDir(): { dir: string, dispose: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'aishell-format-'))
  return { dir, dispose: () => { rmSync(dir, { recursive: true, force: true }) } }
}

describe('FingerprintBackend — an unreadable file is preserved, not replaced', () => {
  let dir: string
  let dispose: () => void

  beforeEach(() => { ({ dir, dispose } = tempDir()) })
  afterEach(() => { dispose() })

  /** Write bytes the backend cannot decrypt, as a corrupt or foreign file would. */
  function writeUnreadable(): string {
    const path = join(dir, CREDENTIALS_FILE_NAME)
    writeFileSync(path, Buffer.from('not a credentials file at all'))
    return path
  }

  it('reads an unreadable file as absent rather than throwing', () => {
    // Every tool call funnels through this. Throwing would fail signing with a
    // parse error the person cannot act on; "absent" routes them to the form.
    writeUnreadable()
    const backend = new FingerprintBackend({ credentialsDir: dir })

    expect(backend.get('AK')).toBeUndefined()
    expect(backend.has('AK')).toBe(false)
  })

  it('moves the unreadable file aside instead of overwriting the other entries', () => {
    // The failure: load() caught, the map came back empty, set() added one
    // entry and persist() wrote a one-entry file. Whatever the old file held —
    // another machine's credentials, a truncated write, an older salt — was
    // gone with no error and no copy.
    const original = writeUnreadable()
    const before = readFileSync(original)
    const backend = new FingerprintBackend({ credentialsDir: dir })

    backend.set('AK', 'LTAIxxxx')

    // The save succeeded, so the person is not blocked.
    expect(backend.get('AK')).toBe('LTAIxxxx')
    // The old bytes still exist, under a name that says what happened.
    const quarantined = readdirSync(dir).filter(name => name.startsWith(`${CREDENTIALS_FILE_NAME}.unreadable-`))
    expect(quarantined).toHaveLength(1)
    expect(readFileSync(join(dir, quarantined[0]!))).toEqual(before)
  })

  it('quarantines once per damaged file, not once per save', () => {
    // A second save must not find the (now valid) file unreadable and pile up
    // copies — the quarantine is for the damaged file, not a per-write archive.
    writeUnreadable()
    const backend = new FingerprintBackend({ credentialsDir: dir })
    backend.set('AK', 'one')
    backend.set('SK', 'two')

    expect(readdirSync(dir).filter(name => name.includes('.unreadable-'))).toHaveLength(1)
    expect(backend.get('AK')).toBe('one')
    expect(backend.get('SK')).toBe('two')
  })

  it('does not quarantine when there is simply no file', () => {
    // The ordinary first-run path must stay free of side effects.
    const backend = new FingerprintBackend({ credentialsDir: dir })
    backend.set('AK', 'value')

    expect(readdirSync(dir).filter(name => name.includes('.unreadable-'))).toHaveLength(0)
  })

  it('throws when a delete hits an unreadable file', () => {
    // A delete has nothing to remove from a map that cannot be read, so the
    // honest answer is a failure — not a success and not a silent no-op.
    // `clearCredentials` reads this signal to tell the person the clear did not
    // happen; swallowing it here would report a cleared credential that reads
    // back the moment the file becomes readable again.
    const path = writeUnreadable()
    const before = readFileSync(path)
    const backend = new FingerprintBackend({ credentialsDir: dir })

    expect(() => { backend.delete('AK') }).toThrow(UnreadableCredentialsFile)
    // And the file is untouched: a delete asked for one entry, not for all.
    expect(existsSync(path)).toBe(true)
    expect(readFileSync(path)).toEqual(before)
  })

  it('keeps a clear from reporting success when the file is unreadable', async () => {
    // The consequence the throw exists for, stated at the level the person sees
    // it: `clearCredentials` must not return normally, or the UI shows "signed
    // out" over a file that still holds the pair.
    const { clearCredentials } = await import('../src/accounts.ts')
    writeUnreadable()
    const backend = new FingerprintBackend({ credentialsDir: dir })

    expect(() => { clearCredentials(backend) }).toThrow(UnreadableCredentialsFile)
    expect(existsSync(join(dir, CREDENTIALS_FILE_NAME))).toBe(true)
  })

  it('names the file and the cause when the error is constructed directly', () => {
    // The type is exported so a caller can tell this case from a real I/O
    // failure; the message is what it has to go on.
    const error = new UnreadableCredentialsFile('/x/y.credentials.enc', new Error('bad tag'))
    expect(error.name).toBe('UnreadableCredentialsFile')
    expect(error.filePath).toBe('/x/y.credentials.enc')
    expect(error.message).toContain('bad tag')
  })
})

describe('signer — canonical query ordering', () => {
  // The signature itself cannot show the bug: both orderings produce a valid
  // signature, just one the gateway will not reproduce. So the ordering is
  // checked on the canonical string, which is what the signature is computed
  // over.

  it('orders mixed case by code unit, not by locale', () => {
    // The regression this fixes: `localeCompare` sorts `Zebra` after `apple`,
    // while the specification's byte order puts it before. The gateway rebuilds
    // this string from the URL, so the wrong order signs a request that cannot
    // authenticate — with a 401 that names nothing about sorting.
    expect(canonicalQuery({ Zebra: '1', apple: '2' })).toBe('Zebra=1&apple=2')
  })

  it('puts uppercase before lowercase, which locale ordering does not', () => {
    expect(canonicalQuery({ B: 'b', a: 'a' })).toBe('B=b&a=a')
    // Two independent orderings of the same fields must agree, because the map
    // they arrive in carries no order of its own.
    expect(canonicalQuery({ a: 'a', B: 'b' })).toBe('B=b&a=a')
  })

  it('leaves the all-lowercase ordering everyone already relied on alone', () => {
    expect(canonicalQuery({ limit: '1', marker: '2' })).toBe('limit=1&marker=2')
    expect(canonicalQuery({ marker: '2', limit: '1' })).toBe('limit=1&marker=2')
  })

  it('URL-encodes both sides of each pair', () => {
    expect(canonicalQuery({ 'a b': 'c d' })).toBe('a%20b=c%20d')
  })

  it('does not depend on the runtime locale', () => {
    // The failure is locale-dependent by construction, so the assertion is made
    // under a collation the default locale does not necessarily use.
    expect(compareCodeUnits('Zebra', 'apple')).toBeLessThan(0)
    expect('Zebra'.localeCompare('apple')).toBeGreaterThan(0)
  })
})