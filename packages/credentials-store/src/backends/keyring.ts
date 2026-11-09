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

  constructor(_config: CredentialsStoreConfig = {}) {
    this.serviceName = KEYRING_SERVICE
    // Required, not preferred: an unavailable Secret Service must throw here so
    // the factory can fall through to a durable backend, rather than silently
    // landing in the kernel keyring's reboot-volatile store.
    this.options = { linux: { store: 'secret-service' } }
    this.Entry = loadKeyring().Entry
    // Probe: a getPassword on a throwaway account exercises the native path.
    new this.Entry(this.serviceName, '__probe__', this.options).getPassword()
  }

  get(account: string): string | undefined {
    try {
      const value = new this.Entry(this.serviceName, account, this.options).getPassword()
      return value ?? undefined
    } catch {
      return undefined
    }
  }

  set(account: string, value: string): void {
    if (value.length === 0) throw new Error('credential value must be non-empty')
    new this.Entry(this.serviceName, account, this.options).setPassword(value)
  }

  delete(account: string): void {
    try {
      new this.Entry(this.serviceName, account, this.options).deletePassword()
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
        throw error
      }
    }
  }

  has(account: string): boolean {
    try {
      return new this.Entry(this.serviceName, account, this.options).getPassword() !== null
    } catch {
      return false
    }
  }
}
