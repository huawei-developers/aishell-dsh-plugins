/**
 * The E2B API key this plugin presents to the sandbox gateway.
 *
 * ## The lifecycle
 *
 * The key is a **stored credential**, not process state:
 *
 *   1. Read the `aishell_e2b` section of the `aishell-credential` bundle.
 *   2. Not there, or past its expiry → `POST /e2b/keys` and store the result.
 *   3. Either way, present the stored key as `X-API-KEY`.
 *
 * Persisting it is what makes a restart cheap and, more importantly, what
 * keeps the key stable. The key *is* the tenant: the gateway derives a caller
 * identity from the presented key and scopes every sandbox record to it, so a
 * key re-created on every start would orphan every sandbox made before it —
 * the model would see "no such sandbox" and never learn why.
 *
 * ## A key with no expiry
 *
 * A key issued with no expiry (`ttl_seconds: 0`) is normalised to
 * `9999-12-31`, so the expiry check stays one comparison instead of two
 * shapes. An `expires_at` that is present but cannot be parsed is treated the
 * same way: a malformed timestamp is not evidence the key stopped working, and
 * treating it as expired would re-create a key on every call — the one
 * behaviour that guarantees orphaning sandboxes. The 401 fallback below still
 * catches a key that really has stopped working.
 *
 * ## Why the call is signed
 *
 * Requesting a key authenticates with the operator's Huawei Cloud AK/SK — the
 * same pair `aishell-llm` signs gateway requests with — so the service can tell
 * whose key to issue.
 *
 * ## Why the key is bound to the AK that minted it
 *
 * A stored key outlives the credentials that created it, so clearing or
 * replacing the AK/SK in the credential form has to take the key with it — a
 * key with no expiry otherwise survives the credential for good, and the old
 * tenant and all its sandboxes stay reachable.
 *
 * The key records a fingerprint of the AK that minted it, and {@link get}
 * discards a stored key whose fingerprint no longer matches the stored
 * credentials. Three consequences are deliberate:
 *
 *   - **No credentials at all also invalidates it.** Clearing them is the
 *     clearest statement that nothing this plugin was granted may still be used.
 *   - **The same AK/SK re-entered does not rotate the key.** A fingerprint
 *     answers "which identity minted this", not "when was it written"; someone
 *     re-saving the same pair has changed nothing, and throwing their running
 *     sandboxes away for it would be gratuitous.
 *   - **No listener is needed.** The check happens on the read path, so it also
 *     catches a store changed outside the credential form, or while this plugin
 *     was not mounted. An event listener would only see the case where this
 *     plugin happened to be running.
 *
 * A key stored by an older build carries no fingerprint. It is treated as
 * matching (see {@link matchesFingerprint}) rather than re-created: rotating it
 * would orphan every sandbox made before this build, and the 401 fallback still
 * covers a key that has genuinely stopped working.
 *
 * @module @huaweidevtools/aishell-dsh-e2b/sandbox-key
 */

import type { CredentialsStore } from '@huaweidevtools/aishell-dsh-credentials-store'
import {
  FOREVER_EXPIRY,
  clearE2BKey,
  fingerprint,
  readE2BKey,
  writeE2BKey,
  type E2BSection,
} from '@huaweidevtools/aishell-dsh-credentials-store/accounts'
import { sign, type SignCredentials } from '@huaweidevtools/aishell-dsh-credentials-store/signer'


/** Path of the key endpoint: POST creates, GET lists. */
export const KEYS_PATH = '/e2b/keys'

/** An error the model can act on, carrying the endpoint's own message. */
export class SandboxKeyError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SandboxKeyError'
  }
}

/** Reads the operator's credentials, or `undefined` when the pair is incomplete. */
export type CredentialsReader = () => SignCredentials | undefined

/** Everything the key source needs; injected so tests drive it without a network. */
export interface SandboxKeyOptions {
  /** Absolute base URL of the provisioning service, no trailing slash. */
  readonly baseUrl: string
  /** Reads the signing credentials per attempt. */
  readonly readCredentials: CredentialsReader
  /** The store holding the `aishell-credential` bundle. */
  readonly store: CredentialsStore
  /** Fetch implementation; defaults to the global. */
  readonly fetchImpl?: typeof fetch
  /** Request timeout in milliseconds. */
  readonly timeoutMs: number
}

/** One key as the store holds it. */
export interface StoredKey {
  /** The secret presented as `X-API-KEY`. */
  readonly key: string
  /** When it stops working, ISO 8601; {@link FOREVER_EXPIRY} for no expiry. */
  readonly expiresAt: string
  /**
   * {@link fingerprint} of the AK that minted this key, or `undefined` for a
   * key stored before fingerprints existed. See the module comment.
   */
  readonly akFingerprint?: string
}

/**
 * Whether a stored key may still be used for the credentials in hand.
 *
 * - No credentials → no, whatever the key says: nothing granted under a
 *   credential set that has since been cleared may still be presented.
 * - No fingerprint on the key (an older build) → yes. Rotating it would orphan
 *   every sandbox made before this build, and that is worse than the gap it
 *   closes; the 401 fallback still catches a dead key.
 * - Otherwise → the fingerprint must equal the current AK's.
 *
 * @param stored - the key read from the store.
 * @param credentials - the credentials in hand, or `undefined` when cleared.
 * @returns `true` when the key belongs to the current credentials.
 */
export function matchesFingerprint(
  stored: StoredKey,
  credentials: SignCredentials | undefined,
): boolean {
  if (credentials === undefined) return false
  if (stored.akFingerprint === undefined) return true
  return stored.akFingerprint === fingerprint(credentials.ak)
}

/**
 * Convert the stored bundle section into this module's shape.
 *
 * Returns `undefined` when there is no usable key: a corrupt section should
 * lead to a new key, not to a half-parsed value presented to the gateway.
 *
 * The section is decoded by the shared store module, so this function only
 * renames fields — it never parses JSON.
 *
 * @param section - the e2b section read from the store.
 * @returns the key, or `undefined` when there is none.
 */
export function fromStoredSection(section: E2BSection | undefined): StoredKey | undefined {
  if (section === undefined) return undefined
  return {
    key: section.api_key,
    expiresAt: section.expired_at,
    // Absent stays absent rather than becoming `''`: `matchesFingerprint` reads
    // absence as "stored before fingerprints", a different answer from a value
    // that matches nothing.
    ...(section.ak_fingerprint === undefined ? {} : { akFingerprint: section.ak_fingerprint }),
  }
}

/**
 * Whether a stored key is past its expiry.
 *
 * @param key - the stored key.
 * @param now - the instant to compare against.
 * @returns `true` when the key should be replaced.
 */
export function isExpired(key: StoredKey, now: number): boolean {
  const at = Date.parse(key.expiresAt)
  // Unparseable is not evidence of expiry — see the module comment.
  if (Number.isNaN(at)) return false
  return at <= now
}

/** The stored form of one key, as the bundle keeps it. */
export function toStoredSection(key: StoredKey): E2BSection {
  return {
    api_key: key.key,
    expired_at: key.expiresAt,
    ...(key.akFingerprint === undefined ? {} : { ak_fingerprint: key.akFingerprint }),
  }
}

/** One key, read from the store and replaced when it expires or is refused. */
export class SandboxKeySource {
  private readonly options: SandboxKeyOptions
  private readonly fetchImpl: typeof fetch
  /** The key in hand, or `undefined` before the first read. */
  private current: StoredKey | undefined
  /** The in-flight create, so concurrent callers share one request. */
  private pending: Promise<StoredKey> | undefined
  /**
   * Bumped by {@link invalidate}.
   *
   * A create signs with the credentials it was handed, and the network round
   * trip is long enough to outlast them: a person can clear or replace their
   * AK/SK while a key is being minted. The generation is how the finished
   * create notices — its value is the one captured before the request, so a
   * mismatch means the credentials it signed under are gone and the key it is
   * holding must not be adopted or stored.
   */
  private generation = 0

  constructor(options: SandboxKeyOptions) {
    this.options = options
    this.fetchImpl = options.fetchImpl ?? fetch
  }

  /**
   * Return a usable API key.
   *
   * A key is used only while it is unexpired **and** still belongs to the
   * credentials in hand — see the module comment on why the second check
   * exists and why a mismatch does not delete the stored entry.
   *
   * @param signal - caller cancellation, forwarded to the fetch.
   * @returns the key to present as `X-API-KEY`.
   * @throws {SandboxKeyError} when no credentials are stored, so nothing can
   *   be created to replace a key the current credentials do not own.
   */
  async get(signal: AbortSignal | undefined): Promise<string> {
    const now = Date.now()
    // Read once, before either cache is consulted: the credentials decide
    // whether the key in hand still belongs to this account at all.
    const credentials = this.options.readCredentials()

    if (
      this.current !== undefined
      && !isExpired(this.current, now)
      && matchesFingerprint(this.current, credentials)
    ) {
      return this.current.key
    }

    // The store is the source of truth, so a key another process wrote is used
    // rather than replaced.
    const stored = fromStoredSection(readE2BKey(this.options.store))
    if (stored !== undefined && !isExpired(stored, now) && matchesFingerprint(stored, credentials)) {
      this.current = stored
      return stored.key
    }

    // A key that is present but belongs to other credentials is left in the
    // store rather than deleted. An empty read is not proof of a clear — a
    // locked or unavailable backend answers `undefined` for entries that are
    // really there — and deleting on that would rotate the tenant every time
    // the keyring hiccuped. The entry is overwritten by the create below as
    // soon as credentials are usable again.
    this.current = undefined

    // Concurrent first calls share one create: two keys would be two tenants,
    // and only the last one stored would survive.
    this.pending ??= this.createKey(credentials, signal)
    try {
      this.current = await this.pending
      return this.current.key
    } finally {
      this.pending = undefined
    }
  }

  /**
   * Forget the key, so the next {@link get} creates a new one.
   *
   * Called when the gateway refuses the key as unauthenticated — the one
   * signal that it has stopped working earlier than its expiry said — and when
   * the stored credentials change.
   *
   * The replacement is a different key, and therefore a different tenant:
   * sandboxes created under the old one stop being reachable through this
   * plugin.
   *
   * ## Why the generation is bumped and `pending` is not cleared
   *
   * Clearing `pending` would let a concurrent caller start a second create
   * immediately, which is two keys and two tenants — the thing the shared
   * promise exists to prevent. Bumping the generation instead leaves the
   * in-flight create shared, and makes it fail when it lands: its key was
   * minted under credentials that no longer exist, so adopting it would put a
   * credential granted under a cleared account back into the store.
   *
   * The clear is best-effort. A store that refuses the delete still has the key
   * dropped from memory, and the fingerprint check rejects it on the next read
   * anyway — throwing here would turn a refresh into a failure the caller
   * cannot act on.
   */
  invalidate(): void {
    this.current = undefined
    this.generation += 1
    // Only the e2b section: the AK/SK live in the same record and are not this
    // plugin's to clear.
    try {
      clearE2BKey(this.options.store)
    } catch {
      // Best-effort: see the note above.
    }
  }

  /**
   * Create a key, store it, and return it.
   *
   * @param credentials - the pair to sign with; already read by {@link get},
   *   so the fingerprint recorded on the key is the one it was minted under.
   * @param signal - caller cancellation, forwarded to the fetch.
   * @throws {SandboxKeyError} when the credentials changed while the request
   *   was in flight, so the key that came back belongs to none of them.
   */
  private async createKey(
    credentials: SignCredentials | undefined,
    signal: AbortSignal | undefined,
  ): Promise<StoredKey> {
    if (credentials === undefined) {
      // Bilingual, and naming only the condition — the same copy
      // `aishell-deploy` uses for its blocked tool call. Which affordance
      // opens the credential form is the UI's business; "authenticate" is what
      // the reader acts on. No `aishell-e2b:` prefix here either: the tool
      // layer already prefixes this message with the call that failed.
      throw new SandboxKeyError(
        '未进行华为云 IAM 认证，请认证后重试。'
        + ' / Not authenticated with Huawei Cloud IAM. Please authenticate, then retry.',
      )
    }

    // Captured before the request: the comparison below is against the state
    // the key was actually minted under, not against whatever is true when it
    // lands.
    const generation = this.generation

    const url = new URL(`${this.options.baseUrl}${KEYS_PATH}`)
    // No body: both create fields are optional, and the service accepts a
    // request that carries neither.
    const headers = sign('POST', url.host, url.pathname, {}, '', credentials)

    const timeout = AbortSignal.timeout(this.options.timeoutMs)
    const composed = signal === undefined ? timeout : AbortSignal.any([signal, timeout])

    let response: Response
    try {
      response = await this.fetchImpl(url, {
        method: 'POST',
        headers: {
          host: headers.host,
          'x-sdk-date': headers['x-sdk-date'],
          Authorization: headers.Authorization,
          ...(headers['x-security-token'] === undefined
            ? {}
            : { 'x-security-token': headers['x-security-token'] }),
        },
        signal: composed,
      })
    } catch (error) {
      throw new SandboxKeyError(
        `aishell-e2b: cannot reach the sandbox key service at ${this.options.baseUrl}: `
        + `${error instanceof Error ? error.message : String(error)}`,
      )
    }

    if (!response.ok) throw new SandboxKeyError(await describeFailure(response))

    // The minting credentials ride on the record, so a later call can tell
    // whether this key still belongs to the account in hand. Recorded from the
    // credentials actually used to sign — not re-read afterwards, which could
    // be a newer pair than the one the service just issued against.
    const created = { ...await readCreatedKey(response), akFingerprint: fingerprint(credentials.ak) }

    // The credentials changed while this request was in flight. Adopting the
    // key would put one minted under a cleared account back into service, and
    // storing it would leave the record behind for the next process — the
    // exact thing an invalidation exists to prevent.
    if (generation !== this.generation) {
      throw new SandboxKeyError(
        'aishell-e2b: the Huawei Cloud credentials changed while a sandbox key was being '
        + 'created, so that key belongs to the previous account and was discarded. '
        + 'Retry with the current credentials.',
      )
    }

    try {
      writeE2BKey(this.options.store, toStoredSection(created))
    } catch {
      // A key that could not be stored is still usable for this process; the
      // next start simply creates another. Reporting a failure here would
      // discard a working key over a storage problem.
    }
    return created
  }
}

/**
 * Turn a failing response into a message naming what the operator can do.
 *
 * Three conditions carry different instructions and must not be flattened:
 *
 *   - `1010` — the account holds too many keys; delete one, then retry.
 *   - `1008` — too many creates recently; wait, then retry.
 *   - `2001`/401 — the signature was refused; check the stored AK/SK.
 */
async function describeFailure(response: Response): Promise<string> {
  let code = ''
  let message = ''
  try {
    const parsed = await response.json() as { error_code?: unknown, error_msg?: unknown }
    if (typeof parsed.error_code === 'string') code = parsed.error_code
    if (typeof parsed.error_msg === 'string') message = parsed.error_msg
  } catch {
    // A non-JSON body (an ingress page, a proxy error) carries nothing to read.
  }

  if (code === 'AISHELL.1010') {
    return 'aishell-e2b: this account already holds the maximum number of sandbox keys. '
      + 'Delete one that is no longer in use, then retry.'
  }
  if (code === 'AISHELL.1008') {
    return 'aishell-e2b: too many sandbox keys were created recently. Retry shortly.'
  }
  if (code === 'AISHELL.2001' || response.status === 401 || response.status === 403) {
    return 'aishell-e2b: the sandbox key service rejected the request signature. '
      + 'Check the stored access key and secret key, then retry.'
  }
  if (code === 'AISHELL.3003') {
    return 'aishell-e2b: the sandbox key service is not ready right now. Retry shortly.'
  }

  const detail = message === '' ? '' : `: ${message}`
  return `aishell-e2b: the sandbox key service failed with HTTP ${response.status}`
    + `${code === '' ? '' : ` (${code})`}${detail}`
}

/**
 * Read the created key out of the response body.
 *
 * The plaintext appears exactly once, in this response — the service keeps only
 * a hash — so a body that does not carry one is a failure, not something to
 * retry against a later read.
 */
async function readCreatedKey(response: Response): Promise<StoredKey> {
  let parsed: unknown
  try {
    parsed = await response.json()
  } catch (error) {
    throw new SandboxKeyError(
      'aishell-e2b: the sandbox key service returned a body that is not JSON: '
      + `${error instanceof Error ? error.message : String(error)}`,
    )
  }

  const body = parsed as { api_key?: unknown, expires_at?: unknown } | null
  const key = body?.api_key
  if (typeof key !== 'string' || key === '') {
    throw new SandboxKeyError(
      'aishell-e2b: the sandbox key service returned no usable key.',
    )
  }
  // Absent `expires_at` means no expiry was requested or granted.
  const expiresAt = typeof body?.expires_at === 'string' && body.expires_at !== ''
    ? body.expires_at
    : FOREVER_EXPIRY
  return { key, expiresAt }
}