import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { join } from 'node:path'
import { clearCredentials, readStoredPair, writeHuaweiCloud } from '../src/accounts.ts'
import { tmpdir } from 'node:os'
import { mkdtempSync } from 'node:fs'
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

const { createCredentialsStore, KeyringBackend, FailoverStore, FingerprintBackend, MemoryBackend, __setKeyringModule, __resetSharedMemoryBackend, sharedMemoryBackend, keyringRefused, __clearKeyringRefusal } = await import('../src/index.ts')

/**
 * The backend class as a type. The destructured `KeyringBackend` above is a
 * value (a constructor), so it cannot be used in a type position; `InstanceType`
 * is how a value's instance type is spelled.
 */
type KeyringBackend = InstanceType<typeof KeyringBackend>

// Inject the mock before any KeyringBackend is constructed.
__setKeyringModule({ Entry: MockEntry })

// The refusal latch is process-wide by design, so it outlives every spec that
// raises it. A suite that did not reset it per test would see one spec's
// refusal decide the next one's backend — the same leak the module-level mock
// above exists to prevent, one level up.
beforeEach(() => {
  __clearKeyringRefusal()
})

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
      // Still a FailoverStore, with an unavailable primary: one shape for every
      // caller, and `unavailable` tells the truth about WHY the credential is
      // missing. Returning the bare file backend would answer "not configured"
      // for a keychain that holds the credential and merely refused to open.
      expect(s).toBeInstanceOf(FailoverStore)
      expect(keyringRefused()).toBe(true)
      expect(s.get('HW_ACCESS_KEY')).toBeUndefined()
    } finally {
      __setKeyringModule({ Entry: MockEntry })
    }
  })

  it('does not even probe a keyring this process already refused', () => {
    // The probe is a read, and on macOS a read of a refused keychain raises the
    // unlock prompt. A second store in the same process must not pay that.
    let probes = 0
    __setKeyringModule({
      Entry: class {
        constructor() { probes += 1; throw new Error('denied') }
        getPassword = (): string | null => null
        setPassword = (): void => {}
        deletePassword = (): void => {}
      },
    })
    try {
      createCredentialsStore()
      const afterFirst = probes
      // The second store must not probe. What it returns is immaterial here;
      // what matters is that constructing it cost no keyring contact.
      createCredentialsStore()
      expect(probes).toBe(afterFirst)
      expect(keyringRefused()).toBe(true)
    } finally {
      __setKeyringModule({ Entry: MockEntry })
      __clearKeyringRefusal()
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
    // Session 2 — a NEW PROCESS. The refusal latch is process-wide, so this
    // process would never try the keyring again; recovering is what a restart
    // does, and clearing the latch is how a spec models one.
    writeFails = false
    __clearKeyringRefusal()
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

describe('KeyringBackend — a refused keyring latches for the process', () => {
  /**
   * A keyring that refuses the way macOS does after a denied unlock: the read
   * throws. The probe is the one read that succeeds, because a refusal at
   * construction is a different case (the factory never builds this backend at
   * all — see `createCredentialsStore`).
   *
   * The latch is process-wide, so every spec here starts from a cleared one and
   * restores it afterwards: the flag outlives any single store by design, which
   * is exactly what makes it leak between specs.
   */
  function refusingKeyring(): { reads: () => number } {
    let reads = 0
    __setKeyringModule({
      Entry: class {
        getPassword = (): string | null => {
          reads += 1
          if (reads === 1) return null
          throw new Error('Error: User canceled the operation. (-128)')
        }
        setPassword = (): void => { throw new Error('Error: User canceled the operation. (-128)') }
        deletePassword = (): void => { throw new Error('Error: User canceled the operation. (-128)') }
      },
    })
    return { reads: () => reads }
  }

  beforeEach(() => {
    __clearKeyringRefusal()
  })

  afterEach(() => {
    __setKeyringModule({ Entry: MockEntry })
    __clearKeyringRefusal()
  })

  it('stops reading once refused, so the unlock prompt stops recurring', () => {
    // Why the latch exists: reconcile polls the store every few seconds, and
    // on macOS each read of a DENIED entry re-raises the unlock prompt. Without
    // the latch, one refusal becomes a dialog that never stops appearing.
    const counted = refusingKeyring()
    const ks = new KeyringBackend()
    const afterProbe = counted.reads()

    expect(ks.get('HW_ACCESS_KEY')).toBeUndefined()
    expect(keyringRefused()).toBe(true)
    expect(counted.reads()).toBe(afterProbe + 1)

    // Every later poll answers from the latch — no keyring contact at all.
    ks.get('HW_ACCESS_KEY')
    ks.get('HW_ACCESS_KEY')
    ks.has('HW_ACCESS_KEY')
    expect(counted.reads()).toBe(afterProbe + 1)
  })

  it('latches the whole process, so a second store does not ask again', () => {
    // Each plugin builds its own store. A latch held per instance would let the
    // second one raise a prompt for a decision the person already made — and
    // the construction probe is a read, so that is where it would happen.
    const counted = refusingKeyring()

    // First store discovers the refusal.
    const first = new KeyringBackend()
    first.get('HW_ACCESS_KEY')
    const afterFirst = counted.reads()

    // The second store's own probe is refused; the factory turns that into the
    // file backend rather than a second prompt (`createCredentialsStore`).
    // Given its own credentials directory so the fallback starts empty — the
    // point here is the read count, not what the fallback holds.
    const second = createCredentialsStore({ credentialsDir: join(tmpdir(), 'refusal-latch') })
    expect(keyringRefused()).toBe(true)
    expect(second.get('HW_ACCESS_KEY')).toBeUndefined()
    // Not one more read: the factory answers from the latch and never
    // constructs a backend, so the refused probe is not repeated.
    expect(counted.reads()).toBe(afterFirst)
  })

  it('reports a latched keyring as unavailable rather than empty', () => {
    // The distinction the interface carries: "nothing stored" invites the
    // person to type a credential in, which would overwrite the one still
    // sitting in a locked keychain.
    refusingKeyring()
    const ks = new KeyringBackend()
    expect(keyringRefused()).toBe(false)
    ks.get('HW_ACCESS_KEY')
    expect(keyringRefused()).toBe(true)
  })

  it('refuses writes after a latch instead of silently accepting them', () => {
    // A quiet success would make FailoverStore believe the value landed and
    // skip its fallback, losing the save.
    refusingKeyring()
    const ks = new KeyringBackend()
    ks.get('HW_ACCESS_KEY')

    expect(() => { ks.set('HW_ACCESS_KEY', 'v') }).toThrow(/not being asked again/)
    expect(() => { ks.delete('HW_ACCESS_KEY') }).toThrow(/not being asked again/)
  })

  it('latches on a refused WRITE too, so a later store does not re-probe', () => {
    // The shape this covers: a keychain unlocked enough to READ but not to
    // WRITE. A save fails, failover writes the file, and without latching the
    // write the next store in this process probes the keyring again — another
    // prompt for an answer the person already gave.
    let reads = 0
    __setKeyringModule({
      Entry: class {
        getPassword = (): string | null => { reads += 1; return null }
        setPassword = (): void => { throw new Error('Error: User canceled the operation. (-128)') }
        deletePassword = (): void => {}
      },
    })
    const dir = mkdtempSync(join(tmpdir(), 'aishell-write-refusal-'))
    const first = createCredentialsStore({ credentialsDir: dir })
    expect(keyringRefused()).toBe(false)

    first.set('HW_ACCESS_KEY', 'AK')   // fails over to the file
    expect(keyringRefused()).toBe(true)
    // The store now reports the keyring's condition, not the fallback's.
    expect(keyringRefused()).toBe(true)

    // A second store answers from the latch and never reads the keyring.
    const afterFirstWrite = reads
    createCredentialsStore({ credentialsDir: dir })
    expect(keyringRefused()).toBe(true)
    expect(reads).toBe(afterFirstWrite)
  })

  it('routes a SAVE to the file too, once a read has latched the process', () => {
    // The read that discovers the refusal must also stop the write from trying:
    // the write would throw, be caught, and fail over anyway, so the attempt
    // buys nothing but another trip into a keyring that will not answer.
    let writes = 0
    __setKeyringModule({
      Entry: class {
        getPassword = (): string | null => { throw new Error('denied') }
        setPassword = (): void => { writes += 1; throw new Error('denied') }
        deletePassword = (): void => { throw new Error('denied') }
      },
    })
    const dir = mkdtempSync(join(tmpdir(), 'aishell-read-then-save-'))
    const store = createCredentialsStore({ credentialsDir: dir })

    expect(store.get('HW_ACCESS_KEY')).toBeUndefined()
    expect(keyringRefused()).toBe(true)

    // Saves through the file without touching the keyring at all.
    expect(() => { store.set('HW_ACCESS_KEY', 'AK') }).not.toThrow()
    expect(writes).toBe(0)
    expect(store.get('HW_ACCESS_KEY')).toBe('AK')
  })

  it('does not treat an absent entry as a refusal', () => {
    // `null` means "no such entry", which a poll may ask about freely. Latching
    // that would silently stop reading a keyring that is working perfectly.
    let reads = 0
    __setKeyringModule({
      Entry: class {
        getPassword = (): string | null => { reads += 1; return null }
        setPassword = (): void => {}
        deletePassword = (): void => {}
      },
    })
    const ks = new KeyringBackend()
    const afterProbe = reads

    expect(ks.get('HW_ACCESS_KEY')).toBeUndefined()
    expect(ks.get('HW_ACCESS_KEY')).toBeUndefined()
    expect(reads).toBe(afterProbe + 2)
    expect(keyringRefused()).toBe(false)
  })

  it('forgets the latch only on a fresh process', () => {
    // Recovery is a restart, and that is what the hook models. Production code
    // has no other way to clear it, which is the whole point.
    refusingKeyring()
    const ks = new KeyringBackend()
    ks.get('HW_ACCESS_KEY')
    expect(keyringRefused()).toBe(true)

    __clearKeyringRefusal()
    expect(keyringRefused()).toBe(false)
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

    // One Entry per account, not one per call: the constructor opens the
    // Secret Service session (~16ms of a ~17ms call), so the backend keeps one
    // per account and reuses it. The probe is a second account, hence two.
    //
    // What the assertion is for is the PIN, and it is asserted on every Entry
    // that exists rather than on a call count: an entry built without the pin
    // reopens the silent-fallback path for every operation it serves.
    expect(seen.length).toBe(2) // probe + AK
    for (const options of seen) {
      expect(options).toEqual({ linux: { store: 'secret-service' } })
    }
  })

  it('constructs one Entry per account and reuses it', () => {
    // The cost this avoids: constructing an Entry measured ~16ms while reading
    // through an existing one measured ~1ms, so per-call construction spends
    // 96% of a read on a session it already had. A status poll every few
    // seconds makes that difference visible.
    let constructed = 0
    class CountingEntry {
      constructor(service: string, account: string, options?: unknown) {
        constructed += 1
        void service
        void account
        void options
      }
      getPassword = (): string | null => null
      setPassword = (): void => {}
      deletePassword = (): void => {}
    }
    __setKeyringModule({ Entry: CountingEntry as never })

    const ks = new KeyringBackend()
    const afterProbe = constructed
    ks.get('AK')
    ks.has('AK')
    ks.set('AK', 'v')
    ks.delete('AK')
    ks.get('AK')

    // Everything after the probe reuses the AK entry.
    expect(constructed).toBe(afterProbe + 1)
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
    // Same shape as every other path: a FailoverStore, reporting the keyring as
    // unavailable, serving from the file backend. Returning the bare file
    // backend here would make `unavailable` lie about a locked keychain.
    const store = createCredentialsStore()
    expect(store).toBeInstanceOf(FailoverStore)
    expect(keyringRefused()).toBe(true)
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

describe('a locked keyring, a person retyping, and a restart', () => {
  /**
   * The whole story one person lives through, asserted end to end because each
   * step's correctness depends on the previous one and no single unit test sees
   * the sequence.
   */
  let keychain: Map<string, string>
  let deny: boolean

  beforeEach(() => {
    __clearKeyringRefusal()
    keychain = new Map()
    deny = false
    __setKeyringModule({
      Entry: class {
        constructor(_service: string, account: string) { this.account = account }
        private readonly account: string
        getPassword = (): string | null => {
          if (deny) throw new Error('Error: User canceled the operation. (-128)')
          return keychain.get(this.account) ?? null
        }
        setPassword = (value: string): void => {
          if (deny) throw new Error('Error: User canceled the operation. (-128)')
          keychain.set(this.account, value)
        }
        deletePassword = (): void => {
          if (deny) throw new Error('Error: User canceled the operation. (-128)')
          keychain.delete(this.account)
        }
      },
    })
  })

  afterEach(() => { __clearKeyringRefusal() })

  it('shows the account name while the keychain is locked, if a file copy exists', () => {
    const dir = mkdtempSync(join(tmpdir(), 'aishell-story-a-'))
    // A previous failover left the pair in the file.
    const seeding = new FingerprintBackend({ credentialsDir: dir })
    writeHuaweiCloud(seeding, { ak: 'FILE-AK', sk: 'FILE-SK' })

    deny = true
    const store = createCredentialsStore({ credentialsDir: dir })

    // Reads route to the file, so the pair is available: the chip shows a name.
    expect(readStoredPair(store)?.ak).toBe('FILE-AK')
    expect(keyringRefused()).toBe(true)
  })

  it('shows nothing when neither backend has a pair, and a retype lands in the file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'aishell-story-b-'))
    deny = true
    const store = createCredentialsStore({ credentialsDir: dir })

    // Nothing anywhere: the chip says "not configured", which is the truth.
    expect(readStoredPair(store)).toBeUndefined()

    // The person opens the form and saves. That must work WITHOUT touching the
    // keychain again — the latch is what keeps the unlock prompt from returning.
    expect(() => { writeHuaweiCloud(store, { ak: 'TYPED-AK', sk: 'TYPED-SK' }) }).not.toThrow()
    expect(readStoredPair(store)?.ak).toBe('TYPED-AK')
    expect(keychain.has('aishell-credential')).toBe(false)

    // And it survives a restart, which is where the fallback matters.
    __clearKeyringRefusal()
    deny = false
    const after = createCredentialsStore({ credentialsDir: dir })
    expect(readStoredPair(after)?.ak).toBe('TYPED-AK')
  })

  it('hands authority back to the keyring once it works again', () => {
    const dir = mkdtempSync(join(tmpdir(), 'aishell-story-c-'))
    // The keychain holds the credential from before the lock.
    const direct = new KeyringBackend()
    writeHuaweiCloud(direct, { ak: 'KEYRING-AK', sk: 'KEYRING-SK' })

    deny = true
    const locked = createCredentialsStore({ credentialsDir: dir })
    writeHuaweiCloud(locked, { ak: 'FILE-AK', sk: 'FILE-SK' })
    expect(readStoredPair(locked)?.ak).toBe('FILE-AK')

    // Restart with the keychain unlocked. The file write was the LATER one, so
    // it wins — the precedence rule, exercised across a restart boundary.
    __clearKeyringRefusal()
    deny = false
    const store = createCredentialsStore({ credentialsDir: dir })
    expect(readStoredPair(store)?.ak).toBe('FILE-AK')

    // Saving again through the healthy keychain is what hands authority back:
    // the shadow is purged by the same call.
    writeHuaweiCloud(store, { ak: 'NEW-KEYRING-AK', sk: 'NEW-SK' })
    expect(readStoredPair(store)?.ak).toBe('NEW-KEYRING-AK')
    // The keyring entry is the encoded bundle, so its CONTENT is asserted by
    // reading it back through a store bound to that keyring alone.
    const directAgain = new KeyringBackend()
    expect(readStoredPair(directAgain)?.ak).toBe('NEW-KEYRING-AK')

    // And a clear removes both, so nothing comes back.
    clearCredentials(store)
    expect(readStoredPair(store)).toBeUndefined()
    expect(keychain.has('aishell-credential')).toBe(false)
  })
})
