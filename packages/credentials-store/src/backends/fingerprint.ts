/**
 * Machine-fingerprint-bound encrypted file backend.
 *
 * When the OS keyring is unavailable (headless Linux, Docker, no keyring
 * daemon), credentials are encrypted with a key derived from the machine UUID
 * (node-machine-id) via scrypt, then AES-256-GCM. File format:
 * [12B nonce][16B tag][ciphertext...].
 *
 * The key never touches disk; the ciphertext is useless on a different machine.
 * Same-user-same-machine is trusted. VM cloning copies the machine UUID — a
 * known limitation, not a security hole.
 */

import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync, mkdirSync, renameSync } from 'node:fs'
import { join } from 'node:path'
import machineIdModule from 'node-machine-id'
import { CREDENTIALS_FILE_NAME } from '../scope.ts'
import { credentialsDir } from '../paths.ts'
import type { CredentialsStore, CredentialsStoreConfig } from '../index.ts'

const machineIdSync: () => string = machineIdModule.machineIdSync

// Deliberately NOT the keyring service name: this is the scrypt salt for
// the encrypted file, and changing it would make every existing
// `credentials.enc` undecryptable — the file would read as empty and the
// credentials would look cleared. It is frozen.
const SALT = 'aishell-dsh/credentials/v1'
const KEY_LEN = 32 // AES-256
const NONCE_LEN = 12 // GCM standard (96-bit nonce)
const TAG_LEN = 16 // 128-bit auth tag

/**
 * scrypt cost parameters, stated rather than inherited.
 *
 * Passing no options lets the runtime's defaults decide, and those are not a
 * promise: Node documents the defaults but does not freeze them, so a runtime
 * that changed them would silently derive a different key and make every
 * existing `credentials.enc` undecryptable. They are part of the on-disk
 * format for the same reason {@link SALT} is — **changing any of them is a
 * breaking change to every stored file**, not a tuning knob.
 *
 * These are the values the format was defined with, so writing them down keeps
 * every existing file readable while removing the runtime from the equation.
 */
const SCRYPT_PARAMS = { N: 16384, r: 8, p: 1 } as const

/**
 * How many quarantine filenames to try before giving up.
 *
 * Collisions are only possible when several saves land in the same millisecond
 * on a machine whose last few saves all quarantined — which is already an
 * unhealthy machine. The bound exists so that case reports itself instead of
 * looping.
 */
const QUARANTINE_NAME_ATTEMPTS = 16

/** Derive a 32-byte key from the machine UUID via scrypt. */
function deriveKey(): Buffer {
  const machineId = machineIdSync()
  return scryptSync(machineId, SALT, KEY_LEN, SCRYPT_PARAMS)
}

/** Encrypt plaintext → [nonce][tag][ciphertext] as a Buffer. */
function fingerprintEncrypt(plaintext: string): Buffer {
  const key = deriveKey()
  const nonce = randomBytes(NONCE_LEN)
  const cipher = createCipheriv('aes-256-gcm', key, nonce)
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()
  return Buffer.concat([nonce, tag, ciphertext])
}

/** Decrypt [nonce][tag][ciphertext] → plaintext. Throws on tamper/wrong machine. */
function fingerprintDecrypt(data: Buffer): string {
  if (data.length < NONCE_LEN + TAG_LEN) {
    throw new Error('credentials file corrupted (too short)')
  }
  const key = deriveKey()
  const nonce = data.subarray(0, NONCE_LEN)
  const tag = data.subarray(NONCE_LEN, NONCE_LEN + TAG_LEN)
  const ciphertext = data.subarray(NONCE_LEN + TAG_LEN)
  const decipher = createDecipheriv('aes-256-gcm', key, nonce)
  decipher.setAuthTag(tag)
  const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()])
  return plaintext.toString('utf8')
}

/**
 * Resolve the directory holding the encrypted credentials file.
 *
 * An explicit `config.credentialsDir` wins; otherwise `<DSH_HOME>/credentials`,
 * resolved by the shared `paths` module so the terraform cache in
 * `aishell-deploy` cannot drift to a different home.
 *
 * Builds are separated by the *file name* — see `../scope.ts` — not by the
 * directory.
 */
function resolveCredentialsDir(config: CredentialsStoreConfig): string {
  return config.credentialsDir ?? credentialsDir()
}

/**
 * A credentials file that exists but cannot be decrypted or parsed.
 *
 * Its own type rather than a plain `Error` because the write path has to tell
 * this case from every other failure: this is the one where overwriting the
 * file would destroy credentials the person still has, so `set` moves it aside
 * first. Anything else propagates unchanged.
 */
export class UnreadableCredentialsFile extends Error {
  constructor(
    /** The file that could not be read. */
    readonly filePath: string,
    /** What decryption or parsing reported. */
    cause: unknown,
  ) {
    super(
      `credentials file ${filePath} exists but could not be decrypted: `
      + (cause instanceof Error ? cause.message : String(cause)),
    )
    this.name = 'UnreadableCredentialsFile'
  }
}

/**
 * Encrypted-file {@link CredentialsStore}. Each account is one entry in a
 * single JSON map, encrypted as one file under the resolved credentials
 * directory, named by the build's credential scope (see `../scope.ts`).
 *
 * Construction probes the machine ID + crypto — if `node-machine-id` cannot
 * resolve a UUID, construction throws and the factory falls back to
 * {@link MemoryBackend}.
 */
export class FingerprintBackend implements CredentialsStore {
  private readonly filePath: string
  private readonly fileDir: string

  constructor(config: CredentialsStoreConfig = {}) {
    this.fileDir = resolveCredentialsDir(config)
    this.filePath = join(this.fileDir, CREDENTIALS_FILE_NAME)
    // Probe: deriveKey exercises node-machine-id. If it throws, the factory
    // falls back to MemoryBackend.
    deriveKey()
  }

  /**
   * Load + decrypt the file into a fresh map. Not cached — credentials are
   * read, used, and dropped so plaintext does not linger in memory between
   * operations. The file I/O + scrypt decrypt per call is acceptable: this is
   * not a hot path (once per chat request, not per token).
   *
   * @throws {@link UnreadableCredentialsFile} when the file exists but cannot be
   *   decrypted or parsed. Callers decide what that means; see the note on
   *   {@link FingerprintBackend.loadForWrite}.
   */
  private load(): Map<string, string> {
    if (!existsSync(this.filePath)) return new Map()
    const encrypted = readFileSync(this.filePath)
    try {
      const plaintext = fingerprintDecrypt(encrypted)
      return new Map(Object.entries(JSON.parse(plaintext) as Record<string, string>))
    } catch (error) {
      throw new UnreadableCredentialsFile(this.filePath, error)
    }
  }

  /**
   * Load for a write, where an unreadable file must not be silently replaced.
   *
   * ## Why this is not just `load()` with the error swallowed
   *
   * `set` re-encrypts and rewrites the *whole* map. If load failed and returned
   * empty, the next save would write a one-entry file over every other
   * credential the person had stored — with no error, no backup and nothing to
   * recover from. An unreadable file is not proof of an empty one: a truncated
   * write, a machine-id that changed under the file, or a build whose salt
   * moved all look identical from here.
   *
   * So the unreadable file is moved aside instead of overwritten. Saving
   * therefore keeps working on a machine that inherited someone else's file —
   * the documented VM-clone case — while whatever was in it stays on disk under
   * a name that says what happened to it.
   *
   * @returns the current entries, or an empty map when the old file was moved
   *   aside.
   */
  private loadForWrite(): Map<string, string> {
    try {
      return this.load()
    } catch (error: unknown) {
      if (!(error instanceof UnreadableCredentialsFile)) throw error
      this.quarantine(error)
      return new Map()
    }
  }

  /**
   * Move an unreadable file out of the way.
   *
   * The suffix carries a timestamp and, if that name is taken, a counter — the
   * quarantine must never itself throw over a name collision and must never
   * overwrite a previous one, since the files it preserves are the only copy of
   * what was there. The counter is bounded because an unbounded retry loop over
   * a filesystem is a hang, not a fallback; reaching the bound means something
   * outside this process is wrong and saying so is better than spinning.
   */
  private quarantine(cause: Error): void {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    for (let attempt = 0; attempt < QUARANTINE_NAME_ATTEMPTS; attempt += 1) {
      const suffix = attempt === 0 ? '' : `-${attempt}`
      const target = `${this.filePath}.unreadable-${stamp}${suffix}`
      if (existsSync(target)) continue
      try {
        renameSync(this.filePath, target)
        return
      } catch (error: unknown) {
        // Another process quarantined it first: nothing left to move, and the
        // write that follows is against a fresh file either way.
        if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return
        throw new Error(
          `credentials file ${this.filePath} could not be read (${cause.message}), `
          + `and could not be moved aside to ${target} either: ${String(error)}`,
        )
      }
    }
    throw new Error(
      `credentials file ${this.filePath} could not be read (${cause.message}), and every `
      + `quarantine name is taken up to ${QUARANTINE_NAME_ATTEMPTS} attempts — `
      + 'move the file aside by hand before saving again.',
    )
  }

  /** Encrypt + write the map to disk with owner-only permissions. */
  private persist(entries: Map<string, string>): void {
    const plaintext = JSON.stringify(Object.fromEntries(entries))
    mkdirSync(this.fileDir, { recursive: true, mode: 0o700 })
    // Write owner-only (0600); on platforms that ignore the mode (Windows)
    // the file is still encrypted, and ACLs inherit from the profile dir.
    writeFileSync(this.filePath, fingerprintEncrypt(plaintext), { mode: 0o600 })
  }

  /**
   * Read one entry.
   *
   * An unreadable file reads as absent rather than throwing. The alternative —
   * failing every tool call on a parse error — leaves the person with no
   * working path; "not authenticated" at least routes them to the form that can
   * fix it. The write path is where the difference is preserved; see
   * {@link FingerprintBackend.loadForWrite}.
   */
  get(account: string): string | undefined {
    try {
      return this.load().get(account)
    } catch {
      return undefined
    }
  }

  set(account: string, value: string): void {
    if (value.length === 0) throw new Error('credential value must be non-empty')
    const entries = this.loadForWrite()
    entries.set(account, value)
    this.persist(entries)
  }

  /**
   * Remove one entry.
   *
   * An unreadable file **throws** rather than being a silent no-op. There is
   * nothing to remove from a map that cannot be read, and answering "done"
   * would be a clear that did not clear: the file stays on disk, and the
   * moment whatever made it unreadable is undone — a restored machine id, a
   * repaired file — the credential reads back. `clearCredentials` relies on
   * exactly this signal to tell the person the clear failed.
   *
   * Quarantining instead is not an option here: it would move the file out of
   * the way, which is the destruction this method must not perform — a delete
   * asked for one entry, not for every entry.
   *
   * @throws {@link UnreadableCredentialsFile} when the file cannot be read.
   */
  delete(account: string): void {
    const entries = this.load()
    if (entries.delete(account)) {
      this.persist(entries)
    }
  }

  has(account: string): boolean {
    try {
      return this.load().has(account)
    } catch {
      return false
    }
  }
}
