/**
 * Credential storage abstraction for aishell DSH plugins.
 *
 * Upper layers (aishell-llm's adapter, aishell-credentials' host half)
 * call {@link createCredentialsStore} and get a {@link CredentialsStore} —
 * they never learn which backend is serving. The factory probes backends in
 * priority order (OS keyring first, process memory last) and returns the
 * first that answers, so a backend can be added to the chain without any
 * caller changing. A keyring that answers the probe but later rejects writes
 * fails over to the next backend on first failure.
 *
 * This is a tool library, not a DSH plugin — no `dsh.client`, no
 * `cordis.patch.yml`, no `apply`. DSH's own `ctx.credentials` is untouched;
 * user-configured models and `.credentials.yaml` keep working.
 *
 * @module @huaweidevtools/aishell-dsh-credentials-store
 */

import { KeyringBackend, keyringRefused } from './backends/keyring.ts'
import { FingerprintBackend } from './backends/fingerprint.ts'
import { sharedMemoryBackend } from './backends/memory.ts'
import { FailoverStore } from './failover.ts'

/** Options shared by every backend / the factory. */
export interface CredentialsStoreConfig {
  /**
   * Explicit directory for the fingerprint encrypted-file backend. When set,
   * overrides the default `$DSH_HOME/credentials` resolution. Callers rarely
   * need this — the host's `DSH_HOME` already places credentials alongside
   * its other data.
   */
  readonly credentialsDir?: string
}

/**
 * Read/write a named credential. Backends are synchronous and per-call — no
 * cache, so a credential changed from outside is visible on the next `get`.
 * Absent credentials read as `undefined` / `has === false`; a backend that
 * cannot serve (e.g. no D-Bus secret service) degrades the same way rather
 * than throwing on read.
 */
export interface CredentialsStore {
  /** Read one credential; `undefined` when absent or backend unavailable. */
  get(account: string): string | undefined
  /** Store one credential. Rejects an empty value; throws on backend errors. */
  set(account: string, value: string): void
  /** Remove one credential; absent is a no-op. Throws on backend errors. */
  delete(account: string): void
  /** Whether a credential is currently stored; `false` when absent or backend unavailable. */
  has(account: string): boolean
}

/**
 * Probe backends in priority order and return the first that answers.
 *
 * Priority: OS keyring (durable, cross-process) → machine-fingerprint
 * encrypted file (durable, same-machine) → process memory (volatile,
 * last resort). A backend that cannot initialize — no D-Bus secret service
 * on a headless Linux box, keychain locked, etc. — is skipped, not fatal.
 *
 * A keyring that passes the construction probe but is later found unwritable
 * (GNOME login keyring locked: reads come back null, writes fail — the probe
 * cannot see this) is wrapped in a {@link FailoverStore}: its first failed
 * write fails the whole process over to the fingerprint backend, so saving
 * credentials works instead of erroring. The wrapper also records which
 * accounts the keyring must not answer for, so a credential saved while the
 * collection was locked is not shadowed by the keyring's stale copy once it
 * unlocks.
 *
 * ## A refused probe still yields a FailoverStore
 *
 * The keyring's constructor probe is a real read, so it is the first casualty of
 * a locked keychain at launch. Returning the bare file backend there would give
 * callers two different store shapes for the same question, and would leave the
 * process unaware that a keyring exists at all.
 *
 * So a refused probe installs an {@link UnavailableStore} as the primary instead,
 * and the factory always returns a {@link FailoverStore}. Reads route to the
 * file backend, the refusal is latched process-wide by the keyring module, and a
 * later store on the same process does not pay for another probe.
 *
 * @returns a {@link FailoverStore}, whatever the keyring's condition.
 */
export function createCredentialsStore(config: CredentialsStoreConfig = {}): CredentialsStore {
  const keyring: CredentialsStore | undefined = (() => {
    // A latched refusal is answered from the latch: the probe would only raise
    // another prompt to learn what this process already knows.
    if (keyringRefused()) return undefined
    try {
      return new KeyringBackend(config)
    } catch {
      // OS keyring unavailable (or refused at the probe) — the file backend
      // takes over, and this process will not ask the keyring again.
      return undefined
    }
  })()
  // One shape whether or not the keyring answered. Construction of the fallback
  // stays lazy: a healthy keyring never pays for it.
  return new FailoverStore(
    keyring ?? new UnavailableStore(),
    {
      createFallback: () => createFallbackStore(config),
      // A refused keyring, or the stand-in for one, must not be tried by the
      // write path either — the reads said so already.
      primaryGaveUp: () => keyring === undefined || keyringRefused(),
    },
  )
}

/**
 * A primary that never answers.
 *
 * Stands in for a keyring whose probe was refused, so {@link FailoverStore} has
 * something to hold: reads answer nothing and writes throw, which routes every
 * path through it to the file backend. It exists so a refused probe yields the
 * same store shape as a working one — what a caller acts on is the credential,
 * which the fallback supplies either way.
 */
class UnavailableStore implements CredentialsStore {
  get(_account: string): string | undefined {
    return undefined
  }
  has(_account: string): boolean {
    return false
  }
  set(_account: string, _value: string): void {
    throw new Error('the OS keyring refused this process; it is not being asked again')
  }
  delete(_account: string): void {
    throw new Error('the OS keyring refused this process; it is not being asked again')
  }
}

/** Probe the durable-file and memory backends behind the keyring. */
function createFallbackStore(config: CredentialsStoreConfig): CredentialsStore {
  try {
    return new FingerprintBackend(config)
  } catch {
    // Machine fingerprint unavailable (no machine ID) — fall back to memory.
  }
  // The shared instance, not a fresh one: the keyring and the encrypted file
  // are process-external and therefore already common to every caller, while a
  // private Map is not. Four plugins each call the factory, and on a machine
  // with no keyring they must still be reading one store. See
  // `./backends/memory.ts`.
  return sharedMemoryBackend(config)
}

export { CREDENTIAL_SCOPE, CREDENTIALS_FILE_NAME, DEFAULT_SCOPE, KEYRING_SERVICE } from './scope.ts'
export { KeyringBackend, __setKeyringModule, keyringRefused, __clearKeyringRefusal } from './backends/keyring.ts'
export { FingerprintBackend, UnreadableCredentialsFile, fingerprintDecryptForTest } from './backends/fingerprint.ts'
export { MemoryBackend, __resetSharedMemoryBackend, sharedMemoryBackend } from './backends/memory.ts'
export { FailoverStore } from './failover.ts'
