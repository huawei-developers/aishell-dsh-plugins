/**
 * OS-keyring backend — the durable, cross-process credential store.
 *
 * Wraps `@napi-rs/keyring` (macOS Keychain / Linux Secret Service / Windows
 * Credential Manager). Values persist across process restarts and reboots
 * because the OS owns the store.
 *
 * ## Why Linux pins the Secret Service store
 *
 * On Linux the binding picks a store itself: Secret Service (gnome-keyring,
 * KWallet, KeePassXC) first, then — silently — the kernel keyutils keyring.
 * The kernel keyring is the wrong target for credentials, and the binding's own
 * README says so: it is "completely in-memory and will not persist across
 * reboots". A machine with no Secret Service (a container, CI, a systemd unit
 * with no session bus) would accept credentials, report them stored, and lose
 * them at the next reboot — with `credentialsStored: true` left in the profile
 * pointing at nothing.
 *
 * Pinning `{ linux: { store: 'secret-service' } }` makes an unavailable
 * service throw from the constructor probe instead, so
 * {@link createCredentialsStore} falls through to the machine-fingerprint
 * encrypted file: durable, and honest about where the value lives. Requiring
 * the store is the only way to get that throw — the default selection reports
 * success either way.
 *
 * Native keyring errors are caught: `get`/`has` return `undefined`/`false` so
 * callers degrade gracefully; `set`/`delete` throw a descriptive error so the
 * caller knows the store is unavailable.
 */

import { createRequire } from 'node:module'
import { KEYRING_SERVICE } from '../scope.ts'
import type { CredentialsStore, CredentialsStoreConfig } from '../index.ts'

// Lazily resolved so a missing native binding (the known @napi-rs optional-deps
// bug, or a platform with no prebuilt binary) throws inside the constructor
// probe — where createCredentialsStore's try/catch catches it and falls back
// to FingerprintBackend — instead of crashing at module-load time.
const require = createRequire(import.meta.url)
type KeyringEntry = {
  getPassword: () => string | null
  setPassword: (value: string) => void
  deletePassword: () => void
}
/** Entry options bag; only the Linux store pin is used (see the module note). */
type KeyringEntryOptions = { linux?: { store?: 'secret-service' | 'keyutils' } }
type KeyringModule = {
  Entry: new (service: string, account: string, options?: KeyringEntryOptions) => KeyringEntry
}
let keyringModule: KeyringModule | undefined

/** @internal Test hook: inject a mock keyring module (vi.mock cannot intercept createRequire). */
export function __setKeyringModule(mock: KeyringModule | undefined): void {
  keyringModule = mock
}

function loadKeyring(): KeyringModule {
  if (keyringModule === undefined) keyringModule = require('@napi-rs/keyring') as KeyringModule
  return keyringModule
}

/**
 * Whether this process has been refused by the platform.
 *
 * ## The unit is the process
 *
 * Every plugin that consumes credentials builds its own store, and the platform
 * answers all of them the same way. A latch per store would let each one
 * discover the same refusal, so a person who denied one unlock prompt would be
 * asked again by the next consumer. The refusal is a fact about this process's
 * relationship to the platform, so it is recorded once, here.
 *
 * ## The lifetime is the process
 *
 * A refusal closes both directions. The store that will not be read will not be
 * written either, so no other process can put a credential into it and a poll
 * can learn nothing it did not already know: every further attempt costs one
 * unlock prompt and returns nothing. Asking once and remembering the answer is
 * the only behaviour whose cost is not pure loss.
 *
 * The latch therefore lasts exactly as long as the process does. A person who
 * unlocks the keychain afterwards is served from the next launch, and until
 * then by the failover file — which is where a credential saved while the
 * keyring was unavailable lives (`../failover.ts`). Neither the credential nor
 * the ability to save one is lost in the meantime; what is deferred is the
 * keyring's own copy.
 *
 * Set by {@link KeyringBackend}, read by {@link keyringRefused}.
 */
let refused = false

/** Whether this process's OS keyring has been refused. */
export function keyringRefused(): boolean {
  return refused
}

/**
 * @internal Test hook: forget a recorded refusal, as a fresh process would.
 *
 * Production code never calls this — the whole point is that the latch outlives
 * any one store.
 */
export function __clearKeyringRefusal(): void {
  refused = false
}

/**
 * OS-keyring {@link CredentialsStore}. Constructed with a shared service name;
 * every entry is stored under `new Entry(service, account, { linux: { store:
 * 'secret-service' } })`.
 *
 * Construction probes the keyring once — if the native module cannot be loaded
 * (no prebuilt binding for this platform), or the Linux Secret Service is
 * unavailable, it throws and {@link createCredentialsStore} falls back to the
 * next backend. The pin is what makes the second case throw; see the module
 * note.
 */
export class KeyringBackend implements CredentialsStore {
  private readonly serviceName: string
  private readonly options: KeyringEntryOptions
  private readonly Entry: KeyringModule['Entry']
  /**
   * One `Entry` per account, kept for the process's life.
   *
   * Constructing an `Entry` costs ~16ms while the read on an existing one costs
   * ~1ms — the constructor opens the Secret Service session, and doing that per
   * call spends 96% of a read on setup it already had a moment earlier. Entries
   * are keyed by account because the constructor binds the account name.
   *
   * Reuse is safe for correctness: the native object resolves the entry on each
   * `getPassword`, so a value another process wrote is still seen. Only the
   * session handle is reused.
   */
  private readonly entries = new Map<string, KeyringEntry>()

  constructor(_config: CredentialsStoreConfig = {}) {
    this.serviceName = KEYRING_SERVICE
    // Required, not preferred: an unavailable Secret Service must throw here so
    // the factory can fall through to a durable backend, rather than silently
    // landing in the kernel keyring's reboot-volatile store.
    this.options = { linux: { store: 'secret-service' } }
    this.Entry = loadKeyring().Entry
    // Probe: a getPassword on a throwaway account exercises the native path.
    // A throw here means the platform would not answer — which IS a refusal, and
    // is latched so no later store in this process probes it again. That is what
    // keeps a refused launch to one prompt instead of one per consumer.
    try {
      this.entryFor('__probe__').getPassword()
    } catch (error: unknown) {
      refused = true
      throw error
    }
  }

  /**
   * The `Entry` for one account, constructed on first use.
   *
   * @param account - the credential account name.
   * @returns the cached entry.
   */
  private entryFor(account: string): KeyringEntry {
    let entry = this.entries.get(account)
    if (entry === undefined) {
      entry = new this.Entry(this.serviceName, account, this.options)
      this.entries.set(account, entry)
    }
    return entry
  }

  get(account: string): string | undefined {
    // A refused platform is not asked again. On macOS every read of a denied
    // entry re-raises the unlock prompt, and a refusal means nothing was written
    // since either, so the answer cannot have changed. See `refused`.
    if (refused) return undefined
    try {
      const value = this.entryFor(account).getPassword()
      return value ?? undefined
    } catch {
      // A throw is "the store could not be read", never "no such entry" — the
      // binding reports absence as `null`. Latching it is what stops the next
      // poll from prompting again.
      refused = true
      return undefined
    }
  }

  set(account: string, value: string): void {
    if (value.length === 0) throw new Error('credential value must be non-empty')
    // Throws rather than silently accepting: `FailoverStore` learns the primary
    // is unusable from the throw, and a quiet success here would leave it
    // believing the value landed while the person's save was lost. The message
    // names the condition, not a remedy — the failover layer turns this into a
    // successful save somewhere else, so it is a classification signal rather
    // than anything a person reads.
    if (refused) {
      throw new Error('the OS keyring refused this process; it is not being asked again')
    }
    try {
      this.entryFor(account).setPassword(value)
    } catch (error: unknown) {
      // A refused WRITE is a refusal like any other: the same platform answer
      // that stops reads stops writes, and a read after it would raise the same
      // prompt for nothing. Latching here matters for a machine that launches
      // with the keychain unlockable enough to READ but not to WRITE — without
      // it, every later store in this process probes again and prompts again.
      // The caller still gets the throw, so `FailoverStore` fails over exactly
      // as before.
      refused = true
      throw error
    }
  }

  delete(account: string): void {
    // Like `set`, and for the same reason: a latched keyring must report that it
    // could not delete, or `FailoverStore` would believe the copy is gone and
    // stop masking it.
    if (refused) {
      throw new Error('the OS keyring refused this process; it is not being asked again')
    }
    try {
      this.entryFor(account).deletePassword()
    } catch (error: unknown) {
      // Deleting an absent entry is not an error, but the native binding has no
      // stable code for it — only wording. This filter is deliberately narrow:
      // it matches the *absent-entry* spellings and not "no result found",
      // which a **locked** Secret Service collection reports for entries that
      // really exist. Widening it to cover that would turn a failed clear into
      // a silent no-op, and the credential would keep reading back after the
      // person asked for it to be gone. `FailoverStore.delete` is what handles
      // the locked case — it needs this error to escape from here to see it.
      if (!String(error).includes('not found') && !String(error).includes('no entry')) {
        // Same reasoning as the write path: a refusal is a refusal in every
        // direction, so it is latched before the error escapes to failover.
        refused = true
        throw error
      }
    }
  }

  has(account: string): boolean {
    // Shares `get`'s answer, so `has` cannot prompt where `get` would not, and
    // the two never disagree about the same account.
    return this.get(account) !== undefined
  }
}
