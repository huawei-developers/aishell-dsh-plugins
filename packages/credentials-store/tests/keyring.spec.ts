import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { join } from 'node:path'
import { KEYRING_SERVICE, CREDENTIALS_FILE_NAME } from '../src/scope.ts'

// Mock @napi-rs/keyring via the test hook — vi.mock cannot intercept
// createRequire (the lazy-load path), so we inject the mock module directly.
const store = new Map<string, string>()

class MockEntry {
  constructor(
    private readonly service: string,
    private readonly account: string,
  ) {}

  private key(): string {
    return `${this.service}:${this.account}`
  }

  setPassword(value: string): void {
    store.set(this.key(), value)
  }

  getPassword(): string | null {
    return store.get(this.key()) ?? null
  }
  deletePassword(): void {
    store.delete(this.key())
  }
}

const { createCredentialsStore, KeyringBackend, FailoverStore, FingerprintBackend, MemoryBackend, __setKeyringModule, __resetSharedMemoryBackend, sharedMemoryBackend } = await import('../src/index.ts')

/**
 * The backend class as a type. The destructured `KeyringBackend` above is a
 * value (a constructor), so it cannot be used in a type position; `InstanceType`
 * is how a value's instance type is spelled.
 */
type KeyringBackend = InstanceType<typeof KeyringBackend>

// Inject the mock before any KeyringBackend is constructed.
__setKeyringModule({ Entry: MockEntry })

describe('createCredentialsStore — backend selection', () => {
  beforeEach(() => {
    store.clear()
  })

  it('returns a keyring-backed FailoverStore when the OS keyring is reachable', () => {
    const s = createCredentialsStore()
    expect(s).toBeInstanceOf(FailoverStore)
    // The primary inside the wrapper is a KeyringBackend — the reachable case
    // must still prefer the OS keyring, now behind the write-failover wrapper.
    expect(s.set('K', 'v')).toBeUndefined()
    expect(store.get(`${KEYRING_SERVICE}:K`)).toBe('v')
    expect(s.get('K')).toBe('v')
  })

  it('falls back to FingerprintBackend when KeyringBackend construction throws', () => {
    // Declared as a class expression rather than a bare `class {}` so it still
    // satisfies `KeyringModule["Entry"]`: the seam types the constructor's
    // result as `KeyringEntry`, and a class with no methods does not.
    __setKeyringModule({
      Entry: class {
        constructor() {
          throw new Error('no secret service')
        }

        getPassword = (): string | null => null
        setPassword = (): void => {}
        deletePassword = (): void => {}
      },
    })
    try {
      const s = createCredentialsStore()
      expect(s).toBeInstanceOf(FingerprintBackend)
    } finally {
      __setKeyringModule({ Entry: MockEntry })
    }
  })
})

describe('FailoverStore — keyring write failure (locked collection)', () => {
  /** Mock that reads fine but rejects every write — the locked-keyring shape. */
  let writeFails: boolean

  class LockMockEntry {
    constructor(
      private readonly service: string,
      private readonly account: string,
    ) {}

    private key(): string {
      return `${this.service}:${this.account}`
    }

    setPassword(value: string): void {
      if (writeFails) {
        throw new Error("Couldn't access platform storage: Secret Service: no result found")
      }
      store.set(this.key(), value)
    }

    getPassword(): string | null {
      return store.get(this.key()) ?? null
    }

    deletePassword(): void {
      if (writeFails) throw new Error('no result found')
      store.delete(this.key())
    }
  }

  beforeEach(() => {
    store.clear()
    writeFails = true
    __setKeyringModule({ Entry: LockMockEntry })
  })

  afterEach(() => {
    __setKeyringModule({ Entry: MockEntry })
  })

  it('reads through the keyring (locked reads null) — the construction probe passes', () => {
    const s = createCredentialsStore()
    expect(s).toBeInstanceOf(FailoverStore)
    expect(s.get('ABSENT')).toBeUndefined()
  })

  it('fails a locked-keyring write over to the fingerprint backend instead of throwing', () => {
    const s = createCredentialsStore()
    expect(() => s.set('HW_ACCESS_KEY', 'LTAIxxxx')).not.toThrow()
    // Landed in the fingerprint backend (sandboxed dir), not the keyring.
    expect(store.get(`${KEYRING_SERVICE}:HW_ACCESS_KEY`)).toBeUndefined()
    expect(s.get('HW_ACCESS_KEY')).toBe('LTAIxxxx')
    expect(s.has('HW_ACCESS_KEY')).toBe(true)
  })

  it('sticky failover: a later write does not hit the failing keyring again', () => {
    const s = createCredentialsStore()
    s.set('A', '1')
    // Keyring unlock mid-session: writes would now succeed — but failover is
    // sticky, so the value still goes to the fingerprint backend.
    writeFails = false
    s.set('B', '2')
    expect(store.get(`${KEYRING_SERVICE}:B`)).toBeUndefined()
    expect(s.get('B')).toBe('2')
  })

  it('delete clears both sides after failover', () => {
    const s = createCredentialsStore()
    s.set('A', '1')
    s.delete('A')
    expect(s.get('A')).toBeUndefined()
    expect(s.has('A')).toBe(false)
  })

  it('read-through sees a credential a previous session stored via failover', () => {
    // Session 1: keyring locked, save fails over to the fingerprint file.
    const s1 = createCredentialsStore()
    s1.set('HW_ACCESS_KEY', 'from-failover')
    // Session 2: fresh process, keyring still locked-but-readable.
    writeFails = true
    const s2 = createCredentialsStore()
    expect(s2.get('HW_ACCESS_KEY')).toBe('from-failover')
    expect(s2.has('HW_ACCESS_KEY')).toBe(true)
  })

  it('a locked-keyring delete (save route deletes first) fails over instead of throwing', () => {
    const s = createCredentialsStore()
    // The save route's shape: delete the old set, then write the new one.
    expect(() => s.delete('HW_ACCESS_KEY')).not.toThrow()
    expect(() => s.set('HW_ACCESS_KEY', 'new-ak')).not.toThrow()
    expect(s.get('HW_ACCESS_KEY')).toBe('new-ak')
    // Delete tripped the failover, so the write never touched the keyring.
    expect(store.get(`${KEYRING_SERVICE}:HW_ACCESS_KEY`)).toBeUndefined()
  })

  it('a successful keyring write purges the fallback copy of that account', () => {
    const s1 = createCredentialsStore()
    s1.set('A', 'failover-value')
    // Session 2: keyring now writable; the same account is stored directly.
    writeFails = false
    const s2 = createCredentialsStore()
    s2.set('A', 'keyring-value')
    // The stale failover copy is gone, so a later keyring miss reads absent
    // rather than resurfacing the old value.
    expect(s2.get('A')).toBe('keyring-value')
    store.clear()
    expect(s2.get('A')).toBeUndefined()
  })

  it('a clear while locked does not resurrect the credential once the keyring unlocks', () => {
    // A previous session stored the credential while the collection was
    // writable — the keyring holds it, which is the state a lock-then-clear
    // has to actually remove.
    writeFails = false
    new KeyringBackend().set('RESURRECT', 'old-ak')
    expect(store.get(`${KEYRING_SERVICE}:RESURRECT`)).toBe('old-ak')

    // The collection locks (a reboot on a machine whose keyring re-locks, or
    // an alias repointed at another collection). The user clears credentials.
    writeFails = true
    const session1 = createCredentialsStore()
    expect(() => session1.delete('RESURRECT')).not.toThrow()
    // Reads absent right now, so Settings reports "no credentials" — the
    // clear looks like it worked.
    expect(session1.get('RESURRECT')).toBeUndefined()

    // The collection unlocks. A later session must not read back the
    // credential the clear was supposed to remove.
    writeFails = false
    const session2 = createCredentialsStore()
    expect(session2.get('RESURRECT')).toBeUndefined()
    expect(session2.has('RESURRECT')).toBe(false)
  })

  it('a rotation while locked is not reverted by the keyring copy', () => {
    // The keyring holds the credential to be rotated away from.
    writeFails = false
    new KeyringBackend().set('ROTATE', 'old-ak')

    // The collection locks; the user saves a replacement. The save route
    // deletes the old set first, then writes the new one — so the failing
    // delete trips the failover and the old keyring entry is never removed.
    writeFails = true
    const session1 = createCredentialsStore()
    session1.delete('ROTATE')
    session1.set('ROTATE', 'new-ak')
    expect(session1.get('ROTATE')).toBe('new-ak')

    // The collection unlocks. The next session must sign with the credential
    // the user saved, not the one it replaced.
    writeFails = false
    const session2 = createCredentialsStore()
    expect(session2.get('ROTATE')).toBe('new-ak')
  })

  it('a failover write supersedes an older keyring value across sessions', () => {
    // Same defect as the clear above, without any delete: the keyring holds a
    // value the user has since replaced. This is what a save does when the
    // delete that precedes it is what tripped the failover.
    writeFails = false
    new KeyringBackend().set('SUPERSEDE', 'old-ak')

    writeFails = true
    const session1 = createCredentialsStore()
    session1.set('SUPERSEDE', 'new-ak')
    expect(session1.get('SUPERSEDE')).toBe('new-ak')

    // The collection unlocks. Read-through must not prefer the keyring copy.
    writeFails = false
    const session2 = createCredentialsStore()
    expect(session2.get('SUPERSEDE')).toBe('new-ak')
  })

  it('a deleted account does not hide a later healthy keyring credential', () => {
    // A clear while locked cannot reach the keyring, so the wrapper must
    // remember the deletion. What it must NOT do is keep that memory once the
    // account is stored again — a leftover marker would make a perfectly good
    // keyring credential read as absent.
    writeFails = false
    new KeyringBackend().set('REVIVE', 'ak-1')

    // Locked: the clear cannot reach the keyring, so a marker stands in.
    writeFails = true
    createCredentialsStore().delete('REVIVE')

    // Unlocked. A plain read must still report it gone — the marker is why.
    writeFails = false
    const session2 = createCredentialsStore()
    expect(session2.get('REVIVE')).toBeUndefined()

    // The user stores the credential again, and this time the keyring takes it.
    session2.set('REVIVE', 'ak-2')
    expect(session2.get('REVIVE')).toBe('ak-2')

    // A later session must see it, not the stale deletion.
    const session3 = createCredentialsStore()
    expect(session3.get('REVIVE')).toBe('ak-2')
    expect(session3.has('REVIVE')).toBe(true)
  })
})

describe('KeyringBackend — get/set/delete/has', () => {
  beforeEach(() => {
    store.clear()
  })

  function makeStore(): KeyringBackend {
    return new KeyringBackend()
  }

  it('get returns undefined for an absent account', () => {
    const ks = makeStore()
    expect(ks.get('ABSENT')).toBeUndefined()
  })

  it('set then get returns the value', () => {
    const ks = makeStore()
    ks.set('HW_ACCESS_KEY', 'LTAIxxxx')
    expect(ks.get('HW_ACCESS_KEY')).toBe('LTAIxxxx')
  })

  it('set rejects an empty value', () => {
    const ks = makeStore()
    expect(() => ks.set('EMPTY', '')).toThrow('non-empty')
  })

  it('delete removes the value', () => {
    const ks = makeStore()
    ks.set('TEMP', 'secret')
    ks.delete('TEMP')
    expect(ks.get('TEMP')).toBeUndefined()
  })

  it('delete on absent is a no-op', () => {
    const ks = makeStore()
    expect(() => ks.delete('NOPE')).not.toThrow()
  })

  it('has reports presence correctly', () => {
    const ks = makeStore()
    expect(ks.has('HW_AK')).toBe(false)
    ks.set('HW_AK', 'val')
    expect(ks.has('HW_AK')).toBe(true)
    ks.delete('HW_AK')
    expect(ks.has('HW_AK')).toBe(false)
  })
})

describe('KeyringBackend — config', () => {
  beforeEach(() => {
    store.clear()
  })

  it('uses the fixed service name', () => {
    // A constant, not a setting: see KEYRING_SERVICE. A per-plugin choice of
    // namespace is how a writer and a reader end up in different stores while
    // both report success.
    const ks = new KeyringBackend()
    ks.set('TEST', 'val')
    expect(store.get(`${KEYRING_SERVICE}:TEST`)).toBe('val')
  })

  it('ignores a service value smuggled through the config type', () => {
    // The field is gone from the type; this pins that passing one anyway —
    // a stale profile or a cast — cannot move the entry to another namespace.
    const ks = new KeyringBackend({ service: 'custom-service' } as never)
    ks.set('TEST', 'val')
    expect(store.get(`${KEYRING_SERVICE}:TEST`)).toBe('val')
    expect(store.get('custom-service:TEST')).toBeUndefined()
  })
})

describe('KeyringBackend — the Linux store pin', () => {
  afterEach(() => {
    __setKeyringModule({ Entry: MockEntry })
  })

  it('pins every entry to the Secret Service store', () => {
    // The whole point of the pin: `@napi-rs/keyring` silently falls back to the
    // kernel keyutils keyring when no Secret Service answers, and that store is
    // in-memory only — it does not survive a reboot. Requiring the store is what
    // turns "no Secret Service" into a constructor throw, which is what lets
    // createCredentialsStore fall through to the durable fingerprint file.
    // Asserted on every call, not just the probe: one unpinned Entry would
    // reopen the silent-fallback path for that operation.
    const seen: Array<unknown> = []
    class RecordingEntry {
      constructor(service: string, account: string, options?: unknown) {
        seen.push(options)
        void service
        void account
      }
      getPassword = (): string | null => null
      setPassword = (): void => {}
      deletePassword = (): void => {}
    }
    __setKeyringModule({ Entry: RecordingEntry as never })

    const ks = new KeyringBackend()
    ks.set('AK', 'v')
    ks.get('AK')
    ks.has('AK')
    ks.delete('AK')

    expect(seen.length).toBe(5) // probe + set + get + has + delete
    for (const options of seen) {
      expect(options).toEqual({ linux: { store: 'secret-service' } })
    }
  })

  it('falls through to the fingerprint backend when the pinned store is unavailable', () => {
    // What an absent Secret Service looks like once the store is required: the
    // constructor throws rather than quietly landing in the reboot-volatile
    // kernel keyring.
    __setKeyringModule({
      Entry: class {
        constructor() {
          throw new Error('Platform failure: DBus error: Failed to connect to socket')
        }

        getPassword = (): string | null => null
        setPassword = (): void => {}
        deletePassword = (): void => {}
      },
    })
    expect(createCredentialsStore()).toBeInstanceOf(FingerprintBackend)
  })
})

describe('MemoryBackend — get/set/delete/has', () => {
  it('round-trips a value and clears on delete', () => {
    const m = new MemoryBackend()
    expect(m.get('X')).toBeUndefined()
    m.set('X', 'v')
    expect(m.get('X')).toBe('v')
    expect(m.has('X')).toBe(true)
    m.delete('X')
    expect(m.has('X')).toBe(false)
  })

  it('rejects an empty value', () => {
    const m = new MemoryBackend()
    expect(() => m.set('X', '')).toThrow('non-empty')
  })
})

describe('FingerprintBackend — encrypted file round-trip', () => {
  // Use a temp dir per test to avoid polluting the real credential directory.
  let tmpHome: string

  beforeEach(() => {
    tmpHome = process.env.HOME ?? '/tmp'
    process.env.HOME = '/tmp/aishell-test-' + Math.random().toString(36).slice(2)
  })

  afterEach(() => {
    process.env.HOME = tmpHome
  })

  it('round-trips a value through the encrypted file', () => {
    const fp = new FingerprintBackend({ credentialsDir: join(tmpHome, 'creds') })
    expect(fp.get('AK')).toBeUndefined()
    fp.set('AK', 'LTAIxxxx')
    expect(fp.get('AK')).toBe('LTAIxxxx')
    expect(fp.has('AK')).toBe(true)
    fp.delete('AK')
    expect(fp.has('AK')).toBe(false)
  })

  it('names the file by the build scope', () => {
    // The file name is scoped alongside the keyring service, so two builds on
    // one machine cannot collide in either backend.
    const fp = new FingerprintBackend({ credentialsDir: join(tmpHome, 'creds') })
    fp.set('AK', 'x')
    expect(fp['filePath']).toBe(join(tmpHome, 'creds', CREDENTIALS_FILE_NAME))
  })

  it('persists across instances (same machine)', () => {
    const fp1 = new FingerprintBackend({ credentialsDir: join(tmpHome, 'creds') })
    fp1.set('SK', 'secret-sk')
    // New instance reads the same file
    const fp2 = new FingerprintBackend({ credentialsDir: join(tmpHome, 'creds') })
    expect(fp2.get('SK')).toBe('secret-sk')
  })

  it('rejects an empty value', () => {
    const fp = new FingerprintBackend({ credentialsDir: join(tmpHome, 'creds') })
    expect(() => fp.set('X', '')).toThrow('non-empty')
  })
})

describe('the memory fallback is shared between callers', () => {
  it('hands every caller the same store', () => {
    // The reason this matters: four plugins each call `createCredentialsStore`,
    // and the memory backend is the only one of the three that is not shared by
    // construction — the keyring is a daemon and the encrypted file is a path,
    // but two `Map`s share nothing. Without this, a machine with no keyring has
    // one plugin storing a credential and another unable to see it, reporting
    // "not authenticated" right after the person authenticated.
    //
    // Driven through `sharedMemoryBackend` rather than the factory because the
    // factory's choice of backend depends on module-load-time state (a sealed
    // keyring here, the machine id for the file backend) which a test cannot
    // rearrange after import. What the factory does with this function is a
    // one-line call, and the property under test is the function itself.
    __resetSharedMemoryBackend()
    try {
      const first = sharedMemoryBackend()
      const second = sharedMemoryBackend()
      first.set('shared-probe', 'v')
      expect(second.get('shared-probe')).toBe('v')
    } finally {
      __resetSharedMemoryBackend()
    }
  })

  it('lets a test start from an empty store', () => {
    // `__resetSharedMemoryBackend` is what keeps the sharing from leaking
    // between spec files: without it, a credential written by one case would
    // be visible to the next.
    sharedMemoryBackend().set('leftover', 'v')
    __resetSharedMemoryBackend()
    expect(sharedMemoryBackend().get('leftover')).toBeUndefined()
    __resetSharedMemoryBackend()
  })

  it('still hands out an independent store when constructed directly', () => {
    // `new MemoryBackend()` must not become a singleton: specs construct one
    // per case and expect it to start empty.
    const a = new MemoryBackend()
    const b = new MemoryBackend()
    a.set('only-in-a', 'v')
    expect(b.get('only-in-a')).toBeUndefined()
  })
})
