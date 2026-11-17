/**
 * Write-failover wrapper — covers the failure class a construction-time probe
 * cannot see.
 *
 * {@link createCredentialsStore} picks a backend by probing at construction
 * time, but the highest-priority backend (the OS keyring) can pass that probe
 * and still reject every real write: a locked GNOME keyring collection reads as
 * `null` and its `setPassword` fails. Measured on an isolated D-Bus session:
 *
 * - locked collection, no default alias — read 5 ms → null; write 5 ms →
 *   "Couldn't access platform storage: Secret Service: no result found"
 * - locked collection, default alias set (the real-desktop shape) — read
 *   still null; write blocks on the system unlock prompter and rejects with
 *   "Secret Service: unlock prompt was dismissed" when canceled
 *
 * So the write path needs its own fallback chain, and it must be sticky: a
 * locked keyring fails every write, so retrying it per call would surface the
 * same error (or the same prompt) once per account a save writes. Deletes trip
 * the same failover — a locked collection rejects them with the same error, and
 * the save route deletes the old set before writing the new one, so without
 * this a locked keyring would fail the save before the write failover engaged.
 *
 * ## Which copy wins
 *
 * A locked collection answers `null` for entries that are really there, so the
 * primary's copy of an account can be arbitrarily out of date while still
 * reading as authoritative. Once it unlocks, that copy would outrank the value
 * the user saved in the meantime — resurrecting a credential the user rotated
 * or cleared, with every later signature using the superseded key.
 *
 * The two backends cannot be compared by recency (neither records one), so the
 * fallback is treated as authoritative for any account it has an opinion
 * about, and the primary answers only when the fallback has none:
 *
 *   - **A value in the fallback wins.** It is there because a failover write
 *     put it there, and that write is by definition newer than whatever the
 *     primary holds. No bookkeeping is needed — the value shadows the primary
 *     simply by existing.
 *   - **A tombstone means deleted.** A clear whose primary delete failed has
 *     nothing to shadow with, so it writes an explicit marker; without one, the
 *     stale primary copy would read back as present.
 *   - **Otherwise the primary answers**, which is the ordinary healthy path.
 *
 * A successful primary write or delete clears both the fallback value and the
 * tombstone, handing authority back to the keyring.
 *
 * The alternative — marking accounts "stale" on every failover write — would
 * spread one fact across two records: the mark would have to be cleared in
 * lockstep with the value, and a mark left behind after its value was gone
 * would make a perfect keyring credential read as *absent* rather than merely
 * stale. Keeping the shadow in one place avoids that state entirely.
 *
 * ## Why the record is persisted, not held in memory
 *
 * The state it describes outlives the store: the failure is "the keyring is
 * locked now", and the read that would resurrect the credential happens in a
 * later session, after it has unlocked. It is therefore stored in the fallback
 * backend itself — the encrypted file in practice, and merely the process in
 * the memory-backed last resort, where the failover is no more durable either.
 * Keys carry a NUL prefix, which no real credential account can collide with.
 *
 * ## Cost on the healthy path
 *
 * The fallback is consulted on every read (once for a value, once for a
 * tombstone), so one `get` here is up to three store reads. The two costs
 * differ by two orders of magnitude and which one applies is decided by
 * whether a failover ever wrote:
 *
 *   - **Never failed.** The fallback file does not exist, so both lookups stop
 *     at `existsSync` — ~1µs each (measured).
 *   - **Has failed over.** The file exists, so both lookups decrypt it: ~14µs
 *     each after the key derivation is cached, ~42µs for the whole `get`.
 *     Decrypting twice is what a read-through cache would avoid, and it is not
 *     worth one here: the second decrypt is 14µs, and a cache would have to be
 *     invalidated on every write this store or another process makes.
 *
 * The fallback is built on the first read rather than the first failed write,
 * so a machine with a working keyring pays its construction once. That cost is
 * now almost entirely the scrypt key derivation, and the derivation is cached
 * per PROCESS rather than per backend (`./backends/fingerprint.ts`): a second
 * store on the same machine finds the key already derived and pays only a file
 * read. Lazy and cached either way, so later reads are unaffected.
 *
 * @module
 */

import type { CredentialsStore } from './index.ts'

/**
 * Account-name prefix marking an account as deleted while the primary was
 * unreachable.
 *
 * The NUL byte cannot appear in a real account name (`HW_ACCESS_KEY`,
 * `HW_SECRET_KEY`, `HW_SECURITY_TOKEN`), so a tombstone can never be confused
 * with a credential. Tombstones are only ever written to the fallback, never
 * to the keyring.
 */
const TOMBSTONE_PREFIX = '\u0000aishell:tombstone:'

/** The fallback key recording that `account` was deleted. */
const tombstoneKey = (account: string): string => TOMBSTONE_PREFIX + account

/** Tombstone value; never read, only tested for presence. */
const TOMBSTONE_VALUE = '1'

/** Options for {@link FailoverStore}. */
export interface FailoverStoreOptions {
  /**
   * Builds the store that takes over when the primary fails a write. Called
   * at most once, lazily, on first need — a read miss or the first failed
   * write — so a healthy keyring never pays for constructing it. Must not
   * throw: the factory's closure ends in MemoryBackend.
   */
  readonly createFallback: () => CredentialsStore
  /**
   * Whether the primary has given up for the life of this process.
   *
   * The factory is the one place that knows which backend it wrapped and what
   * that backend's refusal means; asking it here keeps this class free of
   * per-backend knowledge. Defaults to "no", which is the answer for a primary
   * that cannot refuse.
   */
  readonly primaryGaveUp?: () => boolean
}

/**
 * A {@link CredentialsStore} that delegates to a primary until the primary
 * fails a write, then fails over — for the life of this store — to a
 * fallback supplied by {@link FailoverStoreOptions.createFallback}.
 *
 * Once a read OR a write finds the primary unusable, this store stops asking it
 * for good — `failedOver` covers both directions, because a store that cannot
 * be read cannot be written either, and a poll that keeps asking buys nothing
 * but another unlock prompt.
 *
 * That decision is per instance, which is not enough on its own: each plugin
 * that consumes credentials builds its own store, so two of them would each
 * discover the same refusal. What keeps the person from being prompted twice is
 * the keyring's own latch (`keyringRefused` in `./backends/keyring.ts`), which
 * is process-wide: the first store to be refused raises it, and every other
 * store learns it through `primaryGaveUp` instead of asking. Correctness across
 * processes still comes from the persisted record.
 *
 * Constructed by {@link createCredentialsStore} around a KeyringBackend whose
 * construction probe passed; not meant for direct use by upper layers.
 */
export class FailoverStore implements CredentialsStore {
  private readonly primary: CredentialsStore
  private readonly createFallback: () => CredentialsStore
  private fallback: CredentialsStore | undefined
  /** Set by the first failed primary write; routes writes thereafter. */
  private failedOver = false
  /**
   * Whether the primary has already given up for the life of this process.
   *
   * A read that returns nothing cannot be told apart from a read that was
   * refused, so this is what the caller of the READ tells the store: having
   * learned the primary is unusable, its writes should not try it either —
   * they would throw, be caught, and fail over anyway, buying one more trip
   * into a keyring that will not answer.
   */
  private readonly primaryGaveUp: () => boolean

  constructor(primary: CredentialsStore, options: FailoverStoreOptions) {
    this.primary = primary
    this.createFallback = options.createFallback
    this.primaryGaveUp = options.primaryGaveUp ?? (() => false)
  }

  /** The lazily built fallback; constructed at most once per store. */
  private get fallbackStore(): CredentialsStore {
    if (this.fallback === undefined) this.fallback = this.createFallback()
    return this.fallback
  }

  /**
   * Drop the tombstone for `account`, if any.
   *
   * Paired with the value purge on every path that hands authority back to the
   * primary. Best-effort: a tombstone that outlives its purpose costs one extra
   * fallback lookup, which must never fail a write the keyring has accepted.
   */
  private clearTombstone(account: string): void {
    try {
      this.fallbackStore.delete(tombstoneKey(account))
    } catch {
      // Best-effort only.
    }
  }

  get(account: string): string | undefined {
    // Fallback value first: it is authoritative for any account a failover
    // write touched, and reading the primary first would let the keyring's
    // out-of-date copy win the moment it unlocked.
    const failedOverValue = this.fallbackStore.get(account)
    if (failedOverValue !== undefined) return failedOverValue
    if (this.fallbackStore.has(tombstoneKey(account))) return undefined
    if (this.failedOver) return undefined
    // A primary the process has already given up on answers nothing without
    // touching the platform — the latch lives in the backend. Learning that here
    // is what stops the next SAVE from trying the primary too: it would throw,
    // be caught, and fail over anyway, so the only thing the extra attempt buys
    // is one more trip into a keyring this process cannot use.
    const value = this.primary.get(account)
    if (value === undefined && this.primaryGaveUp()) this.failedOver = true
    return value
  }

  has(account: string): boolean {
    if (this.fallbackStore.has(account)) return true
    if (this.fallbackStore.has(tombstoneKey(account))) return false
    if (this.failedOver) return false
    const present = this.primary.has(account)
    if (!present && this.primaryGaveUp()) this.failedOver = true
    return present
  }

  set(account: string, value: string): void {
    if (value.length === 0) throw new Error('credential value must be non-empty')
    if (this.failedOver) {
      // The primary has already proved it cannot be written, so the fallback
      // is the only destination left.
      this.fallbackStore.set(account, value)
      this.clearTombstone(account)
      return
    }
    try {
      this.primary.set(account, value)
    } catch (error: unknown) {
      // The primary answered its construction probe but cannot take writes
      // (locked collection, vanished secret service). Fail over — sticky, so
      // the remaining accounts of this save do not each hit the same error (or
      // the same unlock prompt) again — and put the value somewhere durable.
      this.failedOver = true
      try {
        this.fallbackStore.set(account, value)
        this.clearTombstone(account)
      } catch (fallbackError: unknown) {
        throw new Error(
          'credential write failed over, but the fallback store rejected it too: '
          + `${String(fallbackError)} (primary error: ${String(error)})`,
        )
      }
      return
    }
    // The keyring took the write, so it is authoritative for this account
    // again: drop whatever a failed-over session left in the fallback — a
    // value, which would otherwise be read in preference to this write, or a
    // tombstone, which would hide it. Best-effort: failing this cleanup must
    // not fail a save that already succeeded.
    try {
      this.fallbackStore.delete(account)
    } catch {
      // Best-effort purge only.
    }
    this.clearTombstone(account)
  }

  delete(account: string): void {
    // The value goes first: it is what a read would serve, and clearing it is
    // required regardless of what the primary does.
    try {
      this.fallbackStore.delete(account)
    } catch {
      // Best-effort; the tombstone below still masks the primary's copy.
    }
    if (this.failedOver) {
      // The primary cannot be written, so its copy cannot be removed now. Leave
      // a tombstone: with no value left in the fallback to shadow it, this
      // marker is the only record that the account is gone, and a later read
      // would otherwise serve the very credential being cleared.
      this.writeTombstone(account)
      return
    }
    try {
      this.primary.delete(account)
      this.clearTombstone(account)
    } catch {
      // A locked collection fails deletes as well as writes ("no result found"
      // — wording KeyringBackend's absent-entry no-op filter does not match),
      // and the save route deletes before it writes, so this must trip the
      // same sticky failover a failed write would. The copy we could not remove
      // is masked rather than left readable.
      this.failedOver = true
      this.writeTombstone(account)
    }
  }

  /**
   * Record the deletion, or report its failure.
   *
   * Unlike the best-effort cleanups above, a tombstone that cannot be written
   * means the delete silently did not happen and the credential will read back
   * later. That is a failed clear, so it throws rather than being swallowed.
   */
  private writeTombstone(account: string): void {
    this.fallbackStore.set(tombstoneKey(account), TOMBSTONE_VALUE)
  }
}
