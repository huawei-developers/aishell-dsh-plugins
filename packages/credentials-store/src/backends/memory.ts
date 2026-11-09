/**
 * In-memory backend — the volatile last-resort credential store.
 *
 * Used when the OS keyring is unavailable (no secret service, keychain
 * locked, headless box without D-Bus). Entries live in a process-scoped
 * `Map` and are lost when the process exits — durable enough for a single
 * DSH session, not for persistence.
 *
 * Two exports, and the difference between them is who shares what:
 * {@link MemoryBackend} is an independent store, and
 * {@link sharedMemoryBackend} is the one instance every caller in the process
 * resolves to. Its docstring carries the reasoning.
 */

import type { CredentialsStore, CredentialsStoreConfig } from '../index.ts'

/** Process-scoped {@link CredentialsStore}; entries vanish on exit. */
export class MemoryBackend implements CredentialsStore {
  private readonly entries = new Map<string, string>()

  constructor(_config: CredentialsStoreConfig = {}) {
    // Service name is accepted for API symmetry with KeyringBackend but not
    // used: the in-process Map is keyed by account alone.
  }

  get(account: string): string | undefined {
    return this.entries.get(account)
  }

  set(account: string, value: string): void {
    if (value.length === 0) throw new Error('credential value must be non-empty')
    this.entries.set(account, value)
  }

  delete(account: string): void {
    this.entries.delete(account)
  }

  has(account: string): boolean {
    return this.entries.has(account)
  }
}

/**
 * The one memory backend every caller in this process resolves to.
 *
 * ## Why the factory shares an instance
 *
 * Every plugin that stores credentials calls `createCredentialsStore()` for
 * itself — four of them — and each call resolves a backend. The keyring is a
 * daemon and the encrypted file is a path, so two callers reaching either read
 * the same bytes by construction. A `Map` is not: with a fresh one per call,
 * the plugin that saved a credential and the plugin that reads it would be
 * looking at different maps, and the second would report "not authenticated"
 * on a machine where the person had just authenticated.
 *
 * The sharing lives here rather than in {@link MemoryBackend} so that
 * `new MemoryBackend()` still produces an independent store, which is what the
 * specs rely on: a spec that constructs one expects it to start empty, and a
 * singleton class would leak state between spec files.
 *
 * ## Why it is created on first use
 *
 * Creating it at module load would make importing this module mutate state a
 * test then has to account for. Lazy creation keeps the import inert, so a spec
 * that swaps the keyring module in and out leaves no store behind.
 *
 * @param config - forwarded on first construction only; later callers reuse
 *   the instance, since the memory backend keeps nothing config decides.
 * @returns the shared backend.
 */
let shared: MemoryBackend | undefined

export function sharedMemoryBackend(config: CredentialsStoreConfig = {}): MemoryBackend {
  shared ??= new MemoryBackend(config)
  return shared
}

/**
 * Drop the shared instance.
 *
 * For tests, which need each case to start from an empty store. Not called in
 * production: discarding the instance would discard every credential in it.
 */
export function __resetSharedMemoryBackend(): void {
  shared = undefined
}
