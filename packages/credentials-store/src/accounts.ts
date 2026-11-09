/**
 * The Huawei Cloud credential vocabulary every plugin in this set shares.
 *
 * ## Why one module owns the account names
 *
 * The account names and the "AK and SK are one unit" rule are a *persistence*
 * contract. A second declaration of either does not fail a build: it surfaces
 * as one plugin working and another reporting "not authenticated" on a machine
 * where exactly one pair is stored, and the diff that introduced it looks
 * harmless. Keeping them in one file makes the contract have one owner.
 *
 * ## One record, holding the whole bundle
 *
 * The store holds **one** record, `aishell-credential`, whose value is a single
 * JSON bundle encoded as base64:
 *
 * ```json
 * {
 *   "huaweicloud": { "access_key": "…", "secret_key": "…", "security_token": "…" },
 *   "aishell_e2b": { "api_key": "…", "expired_at": "…", "ak_fingerprint": "…" }
 * }
 * ```
 *
 * One record is what makes a save one operation and a read one consistent
 * snapshot:
 *
 *   - **A save is one write.** Splitting the pair across entries makes every
 *     save a sequence, and every backend is per-entry, so a failure between two
 *     of them leaves a half-set behind that nothing rolls back.
 *   - **A read is one read.** Reading the AK and the SK separately lets a
 *     concurrent write land between them: the caller gets a new AK with an old
 *     SK, which passes "both present" and then fails at the gateway with 401,
 *     pointing nowhere near the cause.
 *
 * ## base64 is an encoding, not encryption
 *
 * It keeps the secret from sitting in a plaintext field a person or a log
 * prints while poking at the store. It is **not** a security boundary: anyone
 * who can read the entry can decode it. The actual protection is the backend —
 * the OS keyring, or AES-256-GCM in the file backend.
 *
 * ## Read-modify-write is not atomic across processes
 *
 * {@link updateCredentials} reads the bundle, applies a change and writes it
 * back. Two processes doing that concurrently can lose one of the changes. That
 * is accepted rather than solved: the only writer is a person via the
 * credential form, and both the e2b key and the AK/SK are refreshed by that
 * same person, so a lost update is corrected by the next save. Solving it
 * properly needs compare-and-swap, which the keyring API does not offer.
 *
 * ## One accepted consequence: a partial bundle can overwrite an unreadable one
 *
 * A read that cannot decrypt the file reports "nothing stored", so an
 * {@link updateCredentials} built on it computes its next bundle from an empty
 * one and writes that. For `clearE2BKey` that means the written record carries
 * only whatever the updater added, and the section it could not read is no
 * longer in the live file.
 *
 * That is not repaired here, because there is nothing to repair it *from* — the
 * bytes are unreadable. What limits the damage is the file backend's write path:
 * an unreadable file is moved to `<name>.unreadable-<timestamp>` rather than
 * overwritten, so the old record survives on disk and the next successful save
 * starts from an empty map. A reader who cannot decrypt the file has already
 * lost those credentials; the guarantee is only that the file they were in is
 * not destroyed.
 *
 * @module @huaweidevtools/aishell-dsh-credentials-store/accounts
 */

import { createHash } from 'node:crypto'
import type { CredentialsStore } from './index.ts'
import type { SignCredentials } from './signer.ts'

/**
 * The one store entry holding every credential this repo manages.
 *
 * Part of the persistence contract: renaming it orphans every stored entry
 * while looking like a harmless constant change.
 */
export const CREDENTIAL_ACCOUNT = 'aishell-credential'

/**
 * The per-field account names a store may still hold beside the bundle.
 *
 * These are the read-side names of a store written field-by-field instead of
 * as one record. {@link readCredentials} folds them into
 * {@link CREDENTIAL_ACCOUNT} on first read, so a machine that holds them keeps
 * working; nothing writes them.
 *
 * The order is the order the migration reads them: access key, secret key,
 * token.
 */
export const LEGACY_ACCOUNTS = ['HW_ACCESS_KEY', 'HW_SECRET_KEY', 'HW_SECURITY_TOKEN'] as const

/**
 * The standalone e2b key entry, beside the per-field names above.
 *
 * Folded into the bundle by {@link readCredentials}, for the same reason: a
 * store written before the bundle existed keeps working. Nothing writes it.
 */
export const LEGACY_E2B_ACCOUNT = 'AISHELL_E2B_API_KEY'

/** The Huawei Cloud pair, as the bundle stores it. Snake-case on disk. */
export interface HuaweiCloudSection {
  readonly access_key: string
  readonly secret_key: string
  readonly security_token?: string
}

/**
 * An e2b API key, as the bundle stores it.
 *
 * `ak_fingerprint` is not part of the key the gateway issued — it is a digest
 * of the AK that minted it, so a reader can tell whether the key still belongs
 * to the credentials in hand. Without it, an AK rotation would leave the old
 * key (and so the old tenant, with all its sandboxes) alive. It lives here
 * rather than only in the reader's memory because it has to survive a restart.
 */
export interface E2BSection {
  readonly api_key: string
  /** ISO 8601; `9999-12-31T23:59:59.000Z` when the key does not expire. */
  readonly expired_at: string
  /** {@link fingerprint} of the AK that minted this key, when known. */
  readonly ak_fingerprint?: string
}

/** The whole bundle. Either section may be absent. */
export interface CredentialBundle {
  readonly huaweicloud?: HuaweiCloudSection
  readonly aishell_e2b?: E2BSection
}

/**
 * Encode a bundle for storage.
 *
 * @param bundle - the bundle to store.
 * @returns base64 of its JSON form.
 */
export function encodeBundle(bundle: CredentialBundle): string {
  return Buffer.from(JSON.stringify(bundle), 'utf8').toString('base64')
}

/**
 * Decode a stored value.
 *
 * Anything unreadable reads as an empty bundle rather than throwing: a corrupt
 * entry should behave like "nothing stored" so the person is asked to
 * authenticate again, not so every tool call fails on a parse error.
 *
 * A value that is not base64 is tried as raw JSON first — that is what the
 * legacy e2b entry held, and migration reads it through here.
 *
 * @param raw - the stored string, if any.
 * @returns the decoded bundle; empty when nothing usable is there.
 */
export function decodeBundle(raw: string | undefined): CredentialBundle {
  if (raw === undefined || raw === '') return {}
  const text = decodeText(raw)
  if (text === undefined) return {}
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return {}
  }
  if (parsed === null || typeof parsed !== 'object') return {}
  const candidate = parsed as { huaweicloud?: unknown, aishell_e2b?: unknown }
  return {
    ...(isHuaweiCloudSection(candidate.huaweicloud)
      ? { huaweicloud: candidate.huaweicloud }
      : {}),
    ...(isE2BSection(candidate.aishell_e2b)
      ? { aishell_e2b: candidate.aishell_e2b }
      : {}),
  }
}

/** Decode base64, falling back to the raw string when it is already text. */
function decodeText(raw: string): string | undefined {
  try {
    const decoded = Buffer.from(raw, 'base64')
    // `Buffer.from` never throws on bad base64 — it drops the unusable tail. So
    // the round-trip check is what distinguishes real base64 from legacy JSON.
    if (decoded.toString('base64') === raw.replace(/\s/g, '')) {
      const text = decoded.toString('utf8')
      if (text.trimStart().startsWith('{')) return text
    }
  } catch {
    // Fall through to raw.
  }
  return raw.trimStart().startsWith('{') ? raw : undefined
}

/** Whether a decoded field is a usable Huawei Cloud section. */
function isHuaweiCloudSection(value: unknown): value is HuaweiCloudSection {
  if (value === null || typeof value !== 'object') return false
  const section = value as Record<string, unknown>
  return typeof section.access_key === 'string' && section.access_key !== ''
    && typeof section.secret_key === 'string' && section.secret_key !== ''
    && (section.security_token === undefined || typeof section.security_token === 'string')
}

/** Whether a decoded field is a usable e2b section. */
function isE2BSection(value: unknown): value is E2BSection {
  if (value === null || typeof value !== 'object') return false
  const section = value as Record<string, unknown>
  return typeof section.api_key === 'string' && section.api_key !== ''
    && typeof section.expired_at === 'string' && section.expired_at !== ''
    && (section.ak_fingerprint === undefined || typeof section.ak_fingerprint === 'string')
}

/**
 * Read the whole bundle, folding a per-field store into it on the way.
 *
 * The fold is lazy and idempotent: a read that finds no bundle but finds the
 * per-field names merges them into one record, writes it, and removes the old
 * entries. A failed write leaves them in place so the next read tries again —
 * a store is never left with neither layout.
 *
 * @param store - the caller's credential store.
 * @returns the bundle; empty when nothing is stored.
 */
export function readCredentials(store: CredentialsStore): CredentialBundle {
  const stored = store.get(CREDENTIAL_ACCOUNT)
  if (stored !== undefined) return decodeBundle(stored)

  const migrated = migrateLegacy(store)
  if (migrated === undefined) return {}
  return migrated
}

/**
 * Merge the per-field entries into one record and remove the old ones.
 *
 * @param store - the caller's credential store.
 * @returns the merged bundle, or `undefined` when there was nothing to move.
 */
function migrateLegacy(store: CredentialsStore): CredentialBundle | undefined {
  const ak = store.get(LEGACY_ACCOUNTS[0])
  const sk = store.get(LEGACY_ACCOUNTS[1])
  const token = store.get(LEGACY_ACCOUNTS[2])
  const legacyKey = store.get(LEGACY_E2B_ACCOUNT)

  const huaweicloud: HuaweiCloudSection | undefined =
    ak !== undefined && ak !== '' && sk !== undefined && sk !== ''
      ? {
        access_key: ak,
        secret_key: sk,
        ...(token === undefined || token === '' ? {} : { security_token: token }),
      }
      : undefined

  // The standalone entry carries `{ key, expiresAt, akFingerprint }`; it is
  // re-keyed to the bundle's snake-case spelling here. A bare key with no JSON
  // around it reads as one that never expires, which is the reading the rest of
  // the store gives an unknown expiry.
  const aisleE2B = legacyE2BSection(legacyKey)

  if (huaweicloud === undefined && aisleE2B === undefined) return undefined

  const bundle: CredentialBundle = {
    ...(huaweicloud === undefined ? {} : { huaweicloud }),
    ...(aisleE2B === undefined ? {} : { aishell_e2b: aisleE2B }),
  }

  try {
    store.set(CREDENTIAL_ACCOUNT, encodeBundle(bundle))
  } catch {
    // Could not write the merged record — leave the per-field entries in place
    // so the next read retries rather than losing the credentials.
    return bundle
  }
  // The merged record is durable, so the old entries are redundant now. Each
  // delete is best-effort: a locked keyring rejects deletes as well as writes,
  // and letting that propagate would make a **successful** migration look like
  // a failed read to the caller. A leftover entry costs nothing — a read
  // returns the bundle as soon as it exists, and `clearCredentials` removes
  // these names too — whereas an exception here surfaces as "could not read
  // credentials" on a store that is fine.
  for (const account of LEGACY_ACCOUNTS) { tryDelete(store, account) }
  tryDelete(store, LEGACY_E2B_ACCOUNT)
  return bundle
}

/** Read one standalone e2b entry into its bundle section. */
function legacyE2BSection(raw: string | undefined): E2BSection | undefined {
  if (raw === undefined || raw === '') return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    // Not JSON at all: a bare key. Its expiry is unknown, which reads the same
    // as "does not expire"; the gateway's 401 path covers the difference.
    return { api_key: raw, expired_at: FOREVER_EXPIRY }
  }
  const candidate = parsed as { key?: unknown, expiresAt?: unknown, akFingerprint?: unknown } | null
  if (candidate === null || typeof candidate !== 'object') return undefined
  if (typeof candidate.key !== 'string' || candidate.key === '') return undefined
  return {
    api_key: candidate.key,
    expired_at: typeof candidate.expiresAt === 'string' ? candidate.expiresAt : FOREVER_EXPIRY,
    ...(typeof candidate.akFingerprint === 'string' && candidate.akFingerprint !== ''
      ? { ak_fingerprint: candidate.akFingerprint }
      : {}),
  }
}

/** The expiry recorded for a key that does not expire. */
export const FOREVER_EXPIRY = '9999-12-31T23:59:59.000Z'

/**
 * Delete an entry, swallowing a backend refusal.
 *
 * For every caller whose success does not depend on the delete landing — the
 * migration's cleanup above, and `clearCredentials` below it. The store is
 * allowed to refuse (a locked keyring rejects deletes, a read-only backend has
 * nothing to delete from), and in each of those cases the entry is either
 * already gone or will be superseded; throwing would report a failure for work
 * that is not needed.
 *
 * Not used where the delete *is* the operation — a save route clearing before
 * it writes must know the clear happened, and that path calls `store.delete`
 * directly.
 *
 * @param store - the caller's credential store.
 * @param account - the entry to remove.
 */
function tryDelete(store: CredentialsStore, account: string): void {
  try {
    store.delete(account)
  } catch {
    // Best-effort: see the note above.
  }
}

/**
 * Read the Huawei Cloud pair.
 *
 * AK and SK are read together and treated as one unit: half a pair reads as no
 * credentials rather than an error, so a partially-configured machine gets
 * "authenticate first" instead of a signing failure with no remedy. The
 * SecurityToken is optional and is omitted entirely when absent — an empty
 * string would sign as a third header the gateway then rejects.
 *
 * @param store - the caller's credential store.
 * @returns the pair, or `undefined` when the AK/SK pair is incomplete.
 */
export function readStoredPair(store: CredentialsStore): SignCredentials | undefined {
  const section = readCredentials(store).huaweicloud
  if (section === undefined) return undefined
  return {
    ak: section.access_key,
    sk: section.secret_key,
    ...(section.security_token === undefined ? {} : { securityToken: section.security_token }),
  }
}

/**
 * Whether a complete Huawei Cloud pair is stored.
 *
 * @param store - the caller's credential store.
 */
export function hasStoredPair(store: CredentialsStore): boolean {
  return readStoredPair(store) !== undefined
}

/**
 * Read the stored e2b key.
 *
 * @param store - the caller's credential store.
 * @returns the section, or `undefined` when no key is stored.
 */
export function readE2BKey(store: CredentialsStore): E2BSection | undefined {
  return readCredentials(store).aishell_e2b
}

/**
 * Apply one change to the bundle and write it back.
 *
 * The updater receives the current bundle and returns the next one. Returning
 * `undefined` aborts the write, which is how a caller says "nothing changed" —
 * that matters because every write is a full re-encode, and needlessly
 * rewriting a record while another process reads it is how a spurious
 * "credentials changed" is produced.
 *
 * @param store - the caller's credential store.
 * @param update - computes the next bundle.
 * @returns the bundle now stored.
 */
export function updateCredentials(
  store: CredentialsStore,
  update: (current: CredentialBundle) => CredentialBundle | undefined,
): CredentialBundle {
  const current = readCredentials(store)
  const next = update(current)
  if (next === undefined) return current
  store.set(CREDENTIAL_ACCOUNT, encodeBundle(next))
  return next
}

/**
 * Store the Huawei Cloud pair, replacing whatever is there.
 *
 * One write, so the pair can never be left half-replaced. A save without a
 * token removes a stored one: a token belongs to the credential set that
 * carried it, and inheriting a stale one would sign the next request with
 * someone else's session.
 *
 * @param store - the caller's credential store.
 * @param credentials - the verified pair.
 */
export function writeHuaweiCloud(store: CredentialsStore, credentials: SignCredentials): void {
  updateCredentials(store, current => ({
    ...current,
    huaweicloud: {
      access_key: credentials.ak,
      secret_key: credentials.sk,
      ...(credentials.securityToken === undefined ? {} : { security_token: credentials.securityToken }),
    },
  }))
}

/**
 * Store an e2b key.
 *
 * @param store - the caller's credential store.
 * @param key - the section to store.
 */
export function writeE2BKey(store: CredentialsStore, key: E2BSection): void {
  updateCredentials(store, current => ({ ...current, aishell_e2b: key }))
}

/**
 * Remove the stored e2b key, leaving the Huawei Cloud pair alone.
 *
 * @param store - the caller's credential store.
 */
export function clearE2BKey(store: CredentialsStore): void {
  updateCredentials(store, current => {
    if (current.aishell_e2b === undefined) return undefined
    const { aishell_e2b: _removed, ...rest } = current
    return rest
  })
}

/**
 * Remove every credential this repo writes.
 *
 * The whole record goes, so a clear cannot leave a token or a key behind for
 * the next pair to inherit. Deleting an absent entry is a no-op in every
 * backend.
 *
 * The per-field names are removed as well, so a store the fold never reached
 * does not keep answering after a clear. Those deletes are best-effort and the
 * main record's is not: a refusal on `CREDENTIAL_ACCOUNT` means the credentials
 * are still there and the person has to be told, while the per-field names are
 * leftovers whose removal nothing depends on. Swallowing the first would report
 * a clear that did not happen.
 *
 * @param store - the caller's credential store.
 * @throws when the backend refused to remove the main record.
 */
export function clearCredentials(store: CredentialsStore): void {
  store.delete(CREDENTIAL_ACCOUNT)
  for (const account of LEGACY_ACCOUNTS) tryDelete(store, account)
  tryDelete(store, LEGACY_E2B_ACCOUNT)
}

/**
 * A short, stable digest of an AK, for recording which identity minted a key.
 *
 * The AK rather than the pair: the SK can be rotated independently while the
 * account stays the same, and the tenant the gateway derives is the account. A
 * digest rather than the AK itself keeps the bundle from carrying a second
 * readable copy of a credential identifier.
 *
 * @param ak - the access key.
 */
export function fingerprint(ak: string): string {
  return createHash('sha256').update(ak, 'utf8').digest('hex')
}