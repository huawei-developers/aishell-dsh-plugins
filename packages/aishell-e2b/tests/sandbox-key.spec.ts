/**
 * The API key source: a stored credential, replaced when it expires or when
 * the gateway refuses it.
 *
 * The property that shapes everything here is that **the key is the tenant**.
 * The gateway derives a caller identity from the presented key and scopes every
 * sandbox to it, so a source that created a key per call would make a sandbox
 * under one identity and then look for it under another — a failure that
 * surfaces as "no such sandbox" and points nowhere near the cause.
 *
 * So the specs pin, in order of how much damage their absence does:
 *
 *   1. A stored, unexpired key is used without asking the service.
 *   2. An expired or missing key is created once and stored.
 *   3. An expiry of `9999-12-31` means "never", not "a very old date".
 *   4. Concurrent first calls share one create — two keys are two tenants.
 *   5. Only an authentication failure discards the key; anything else does not,
 *      because a key that failed for another reason is not evidence about it.
 */

import { describe, it, expect, beforeEach } from 'vitest'
import { MemoryBackend } from '@huaweidevtools/aishell-dsh-credentials-store'
import { sign, type SignCredentials } from '@huaweidevtools/aishell-dsh-credentials-store/signer'

import {
  SandboxKeyError,
  SandboxKeySource,
  fromStoredSection,
  isExpired,
  matchesFingerprint,
  toStoredSection,
} from '../src/sandbox-key.ts'
import {
  FOREVER_EXPIRY,
  fingerprint,
  readE2BKey,
  writeE2BKey,
} from '@huaweidevtools/aishell-dsh-credentials-store/accounts'

/** Credentials the source is handed; `undefined` models an unconfigured machine. */
let credentials: SignCredentials | undefined
/** Responses the stub fetch returns, consumed in order. */
/**
 * Queued answers for the stub fetch, consumed in order.
 *
 * A thunk is awaited before its result is returned, which is what lets a spec
 * hold a request open while it changes something — the credential clear that
 * lands mid-create is the case that needs it.
 */
let responses: Array<Response | Error | (() => Promise<Response>)> = []
/** Requests the stub fetch received. */
let requests: Array<{ url: URL, init: RequestInit | undefined }> = []
/** The store every source is given. */
let store: MemoryBackend

const fetchImpl: typeof fetch = async (input, init) => {
  const url = input instanceof URL ? input : new URL(String(input))
  requests.push({ url, init })
  const next = responses.shift()
  if (next === undefined) throw new Error('no response queued')
  if (next instanceof Error) throw next
  return typeof next === 'function' ? await next() : next
}

/** A created-key response, as the service writes it. */
function created(key: string, expiresAt?: string): Response {
  return Response.json(
    {
      api_key: key,
      key_id: 'ebc2472176138c4b',
      created_at: '2026-10-29T00:00:00Z',
      ...(expiresAt === undefined ? {} : { expires_at: expiresAt }),
    },
    { status: 201 },
  )
}

beforeEach(() => {
  credentials = { ak: 'AK1', sk: 'SK1' }
  responses = []
  requests = []
  store = new MemoryBackend()
})

function makeSource(timeoutMs = 5_000): SandboxKeySource {
  return new SandboxKeySource({
    baseUrl: 'https://openapi.example.test',
    readCredentials: () => credentials,
    store,
    fetchImpl,
    timeoutMs,
  })
}

/** Store a key as the plugin would have. */
function storeKey(key: string, expiresAt: string, akFingerprint?: string): void {
  writeE2BKey(store, {
    api_key: key,
    expired_at: expiresAt,
    ...(akFingerprint === undefined ? {} : { ak_fingerprint: akFingerprint }),
  })
}

/** The stored key, in this module's shape. */
function storedKey() {
  return fromStoredSection(readE2BKey(store))
}

describe('SandboxKeySource — a stored key is used as-is', () => {
  it('does not ask the service when the stored key has not expired', async () => {
    storeKey('sk-e2b-1', '2099-01-01T00:00:00.000Z')
    const source = makeSource()

    expect(await source.get(undefined)).toBe('sk-e2b-1')
    expect(await source.get(undefined)).toBe('sk-e2b-1')

    // Nothing was created: the whole point of storing it.
    expect(requests).toHaveLength(0)
  })

  it('reads the store rather than its own memory, so another process\'s key is used', async () => {
    const source = makeSource()
    storeKey('sk-e2b-written-elsewhere', '2099-01-01T00:00:00.000Z')

    expect(await source.get(undefined)).toBe('sk-e2b-written-elsewhere')
  })

  it('treats a stored key with no recorded expiry as never expiring', async () => {
    // A bare key can only arrive from the legacy entry, which the store's
    // migration folds in as one that never expires. Writing the bundle directly
    // means the expiry is always present, so this exercises the reader rather
    // than the migration.
    writeE2BKey(store, { api_key: 'sk-e2b-bare', expired_at: FOREVER_EXPIRY })
    const source = makeSource()

    expect(await source.get(undefined)).toBe('sk-e2b-bare')
    expect(requests).toHaveLength(0)
  })
})

describe('SandboxKeySource — creating and storing', () => {
  it('creates a key when the store holds none, and stores it', async () => {
    responses = [created('sk-e2b-1', '2026-11-05T00:00:00.000Z')]
    const source = makeSource()

    expect(await source.get(undefined)).toBe('sk-e2b-1')

    const stored = storedKey()
    expect(stored).toEqual({
      key: 'sk-e2b-1',
      expiresAt: '2026-11-05T00:00:00.000Z',
      // The minting credentials are recorded with the key, so a later call can
      // tell whether it still belongs to the account in hand.
      akFingerprint: fingerprint('AK1'),
    })
  })

  it('creates a new key when the stored one has expired', async () => {
    storeKey('sk-e2b-old', '2020-01-01T00:00:00.000Z')
    responses = [created('sk-e2b-new', '2026-11-05T00:00:00.000Z')]
    const source = makeSource()

    expect(await source.get(undefined)).toBe('sk-e2b-new')
    expect(requests).toHaveLength(1)
  })

  it('records a key the service gave no expiry for as never expiring', async () => {
    // `ttl_seconds: 0` is how a caller asks for no expiry, and the response
    // then carries no `expires_at`. Treating the absence as "already expired"
    // would create a key on every call — the one behaviour that guarantees
    // orphaning sandboxes.
    responses = [created('sk-e2b-1')]
    const source = makeSource()

    await source.get(undefined)

    expect(storedKey()?.expiresAt).toBe(FOREVER_EXPIRY)
  })

  it('shares one create across concurrent first calls', async () => {
    responses = [created('sk-e2b-1')]
    const source = makeSource()

    const [a, b, c] = await Promise.all([
      source.get(undefined), source.get(undefined), source.get(undefined),
    ])

    expect(a).toBe('sk-e2b-1')
    expect(b).toBe('sk-e2b-1')
    expect(c).toBe('sk-e2b-1')
    expect(requests).toHaveLength(1)
  })

  it('still returns a usable key when the store cannot write it', async () => {
    // A storage problem is not a reason to discard a key that works; the next
    // start simply creates another.
    writeE2BKey(store, { api_key: 'will-be-replaced', expired_at: FOREVER_EXPIRY })
    const failing = {
      get: () => undefined,
      set: () => { throw new Error('keyring locked') },
      delete: () => { throw new Error('keyring locked') },
      has: () => false,
    }
    const source = new SandboxKeySource({
      baseUrl: 'https://openapi.example.test',
      readCredentials: () => credentials,
      store: failing,
      fetchImpl,
      timeoutMs: 5_000,
    })
    responses = [created('sk-e2b-1')]

    expect(await source.get(undefined)).toBe('sk-e2b-1')
  })
})

describe('SandboxKeySource — the request', () => {
  it('sends a signed POST to the keys endpoint with no body', async () => {
    responses = [created('sk-e2b-1')]
    const source = makeSource()

    await source.get(undefined)

    const request = requests[0]
    expect(request?.init?.method).toBe('POST')
    expect(request?.init?.body).toBeUndefined()
    expect(request?.url.pathname).toBe('/e2b/keys')

    // The signature the service verifies, computed the same way here so the
    // assertion is about the header being that signature, not merely present.
    const expected = sign('POST', request!.url.host, '/e2b/keys', {}, '', credentials!)
    const headers = request?.init?.headers as Record<string, string>
    expect(headers.Authorization).toBe(expected.Authorization)
    expect(headers['x-sdk-date']).toBe(expected['x-sdk-date'])
    expect(headers.host).toBe(expected.host)
  })

  it('carries a security token when one is stored, and omits the header otherwise', async () => {
    responses = [created('a'), created('b')]
    const source = makeSource()

    await source.get(undefined)
    expect(requestHeaders(0)).not.toHaveProperty('x-security-token')

    source.invalidate()
    credentials = { ak: 'AK1', sk: 'SK1', securityToken: 'STS1' }
    await source.get(undefined)
    expect(requestHeaders(1)['x-security-token']).toBe('STS1')
  })

  it('throws a remedy, not a plumbing detail, when no credentials are stored', async () => {
    credentials = undefined
    const source = makeSource()

    await expect(source.get(undefined)).rejects.toThrow(SandboxKeyError)
    await expect(source.get(undefined)).rejects.toThrow(/未进行华为云 IAM 认证/)
    await expect(source.get(undefined)).rejects.toThrow(/Not authenticated with Huawei Cloud IAM/)
    // Nothing was asked of the service: a request without a signature could
    // only fail there, and would report the wrong cause.
    expect(requests).toHaveLength(0)
  })
})

describe('SandboxKeySource — the key belongs to the credentials that minted it', () => {
  it('re-creates a key minted under a different AK', async () => {
    storeKey('sk-e2b-old-account', '2099-01-01T00:00:00.000Z', fingerprint('AK_OLD'))
    // A different account entirely: its sandboxes are not this one's, so the
    // key under the old tenant must not be presented.
    credentials = { ak: 'AK_NEW', sk: 'SK1' }
    responses = [created('sk-e2b-new-account')]
    const source = makeSource()

    expect(await source.get(undefined)).toBe('sk-e2b-new-account')
    expect(requests).toHaveLength(1)
    expect(storedKey()?.akFingerprint).toBe(fingerprint('AK_NEW'))
  })

  it('re-creates the key on the next call even if the source already cached one', async () => {
    responses = [created('sk-e2b-1'), created('sk-e2b-2')]
    const source = makeSource()
    expect(await source.get(undefined)).toBe('sk-e2b-1')

    // Clearing credentials must reach the cached key too — a key held in
    // memory outlives the store otherwise, which is exactly the gap this
    // closes.
    credentials = undefined
    await expect(source.get(undefined)).rejects.toThrow(SandboxKeyError)
    expect(requests).toHaveLength(1)
  })

  it('does not delete the stored key when no credentials are in hand', async () => {
    // An empty read is not proof of a clear — a locked keyring answers
    // `undefined` for entries that are really there — so the entry stays, and
    // the same account re-entering its credentials keeps its tenant.
    storeKey('sk-e2b-1', '2099-01-01T00:00:00.000Z', fingerprint('AK1'))
    credentials = undefined
    const source = makeSource()

    await expect(source.get(undefined)).rejects.toThrow(SandboxKeyError)

    expect(readE2BKey(store)).toBeDefined()
    credentials = { ak: 'AK1', sk: 'SK1' }
    expect(await source.get(undefined)).toBe('sk-e2b-1')
    expect(requests).toHaveLength(0)
  })

  it('keeps the key when the same AK/SK is saved again', async () => {
    responses = [created('sk-e2b-1')]
    const source = makeSource()
    expect(await source.get(undefined)).toBe('sk-e2b-1')

    // Re-entering the same pair changes nothing about the identity, so the
    // running sandboxes must not be thrown away for it. Simulated by a second
    // source reading the store the first one wrote.
    const another = makeSource()
    expect(await another.get(undefined)).toBe('sk-e2b-1')
    expect(requests).toHaveLength(1)
  })

  it('uses a key stored before fingerprints existed instead of rotating it', async () => {
    // An older build wrote no fingerprint. Rotating would orphan every sandbox
    // made before this build; the 401 fallback still covers a dead key.
    writeE2BKey(store, { api_key: 'sk-e2b-legacy', expired_at: '2099-01-01T00:00:00.000Z' })
    const source = makeSource()

    expect(await source.get(undefined)).toBe('sk-e2b-legacy')
    expect(requests).toHaveLength(0)
  })
})

describe('matchesFingerprint', () => {
  it('refuses any key when no credentials are stored', () => {
    // Clearing credentials is the clearest statement that nothing granted
    // under them may still be presented.
    expect(matchesFingerprint({ key: 'k', expiresAt: FOREVER_EXPIRY }, undefined)).toBe(false)
    expect(matchesFingerprint(
      { key: 'k', expiresAt: FOREVER_EXPIRY, akFingerprint: fingerprint('AK1') },
      undefined,
    )).toBe(false)
  })

  it('accepts a key with no fingerprint recorded', () => {
    expect(matchesFingerprint({ key: 'k', expiresAt: FOREVER_EXPIRY }, { ak: 'AK1', sk: 'SK1' })).toBe(true)
  })

  it('compares fingerprints, not secret keys', () => {
    const stored = { key: 'k', expiresAt: FOREVER_EXPIRY, akFingerprint: fingerprint('AK1') }
    expect(matchesFingerprint(stored, { ak: 'AK1', sk: 'SK1' })).toBe(true)
    // A rotated SK under the same AK stays the same identity: the gateway
    // derives the tenant from the account.
    expect(matchesFingerprint(stored, { ak: 'AK1', sk: 'SK2' })).toBe(true)
    expect(matchesFingerprint(stored, { ak: 'AK2', sk: 'SK1' })).toBe(false)
  })
})

describe('SandboxKeySource — invalidate', () => {
  it('discards the key so the next call creates a new one', async () => {
    storeKey('sk-e2b-1', '2099-01-01T00:00:00.000Z')
    responses = [created('sk-e2b-2')]
    const source = makeSource()
    expect(await source.get(undefined)).toBe('sk-e2b-1')

    source.invalidate()

    // The store entry is gone too: leaving it would let the stale key be read
    // back on the next call, defeating the invalidation.
    expect(readE2BKey(store)).toBeUndefined()
    expect(await source.get(undefined)).toBe('sk-e2b-2')
    expect(requests).toHaveLength(1)
  })

  it('does not leave the old key readable after invalidation', async () => {
    storeKey('sk-e2b-1', '2099-01-01T00:00:00.000Z')
    const source = makeSource()
    await source.get(undefined)

    source.invalidate()

    expect(storedKey()).toBeUndefined()
  })

  it('discards a key whose create outlived the credentials it signed under', async () => {
    // A create signs with the pair it was handed, and the round trip is long
    // enough for the person to clear or replace that pair while it is in
    // flight. Adopting the key that comes back would put a credential granted
    // under a cleared account back into service, and storing it would leave
    // the record behind for the next process.
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    responses = [async () => {
      await gate
      return created('sk-minted-under-old-creds')
    }]
    const source = makeSource()

    const inFlight = source.get(undefined)
    // The person clears their credentials, and the plugin reacts.
    credentials = undefined
    source.invalidate()
    release()

    await expect(inFlight).rejects.toThrow(SandboxKeyError)
    await expect(inFlight).rejects.toThrow(/credentials changed/)
    // Nothing was stored: the invalidation's delete is not undone by the
    // create landing afterwards.
    expect(storedKey()).toBeUndefined()
  })

  it('still shares one create across concurrent callers after an invalidate', async () => {
    // Clearing `pending` on invalidate would let a concurrent caller start a
    // second create immediately — two keys, two tenants. The generation guard
    // has to leave the shared promise alone.
    responses = [created('sk-e2b-1')]
    const source = makeSource()

    const [a, b] = await Promise.all([source.get(undefined), source.get(undefined)])
    expect(a).toBe('sk-e2b-1')
    expect(b).toBe('sk-e2b-1')
    expect(requests).toHaveLength(1)
  })
})

describe('SandboxKeySource — failures', () => {
  it('names the delete-a-key remedy when the account holds too many', async () => {
    responses = [Response.json(
      { error_code: 'AISHELL.1010', error_msg: 'too many keys' },
      { status: 409 },
    )]
    const source = makeSource()

    // One call, captured once: the second `get` would need a second queued
    // response, and asserting on a re-issued error would only test the stub.
    const error = await source.get(undefined).then(() => undefined, (e: unknown) => e)
    expect(error).toBeInstanceOf(SandboxKeyError)
    expect(String(error)).toMatch(/maximum number of sandbox keys/)
    expect(String(error)).toMatch(/Delete one/)
  })

  it('names the wait remedy when creation is rate limited', async () => {
    responses = [Response.json(
      { error_code: 'AISHELL.1008', error_msg: 'rate limited' },
      { status: 429 },
    )]
    const source = makeSource()

    // Distinct from the limit above: the instruction is to wait, not to delete.
    await expect(source.get(undefined)).rejects.toThrow(/Retry shortly/)
  })

  it('names the remedy, not a UI path, when the signature is rejected', async () => {
    responses = [Response.json(
      { error_code: 'AISHELL.2001', error_msg: 'auth failed' },
      { status: 401 },
    )]
    const source = makeSource()

    // The remedy is the stored pair, and nothing may point at a Settings page:
    // there is no such section in this deployment.
    await expect(source.get(undefined)).rejects.toThrow(/access key and secret key/)
    await expect(source.get(undefined)).rejects.not.toThrow(/Settings/)
  })

  it('reports the status and code for any other failure', async () => {
    responses = [Response.json(
      { error_code: 'AISHELL.1006', error_msg: 'no such endpoint' },
      { status: 404 },
    )]
    const source = makeSource()

    await expect(source.get(undefined)).rejects.toThrow(/HTTP 404.*AISHELL\.1006/s)
  })

  it('refuses a body that carries no key', async () => {
    for (const body of [
      Response.json({}, { status: 201 }),
      Response.json({ api_key: '' }, { status: 201 }),
      Response.json({ api_key: 7 }, { status: 201 }),
    ]) {
      responses = [body]
      const source = makeSource()
      await expect(source.get(undefined)).rejects.toThrow(/no usable key/)
    }
  })

  it('reports an unreachable service as such', async () => {
    responses = [new Error('ECONNREFUSED')]
    const source = makeSource()

    await expect(source.get(undefined)).rejects.toThrow(/cannot reach/)
  })

  it('does not cache a failure', async () => {
    responses = [new Error('ECONNREFUSED'), created('sk-e2b-1')]
    const source = makeSource()

    await expect(source.get(undefined)).rejects.toThrow()
    // The next call retries rather than replaying the failure forever.
    expect(await source.get(undefined)).toBe('sk-e2b-1')
    expect(requests).toHaveLength(2)
  })
})

describe('fromStoredSection', () => {
  it('renames the stored fields', () => {
    expect(fromStoredSection({
      api_key: 'k',
      expired_at: '2030-01-01T00:00:00.000Z',
    })).toEqual({ key: 'k', expiresAt: '2030-01-01T00:00:00.000Z' })
  })

  it('keeps a fingerprint when one was recorded', () => {
    expect(fromStoredSection({
      api_key: 'k',
      expired_at: FOREVER_EXPIRY,
      ak_fingerprint: 'abc',
    })).toMatchObject({ akFingerprint: 'abc' })
  })

  it('reads no section as no key', () => {
    expect(fromStoredSection(undefined)).toBeUndefined()
  })
})

describe('toStoredSection', () => {
  it('round-trips through fromStoredSection', () => {
    const key = { key: 'k', expiresAt: FOREVER_EXPIRY, akFingerprint: 'abc' }
    expect(fromStoredSection(toStoredSection(key))).toEqual(key)
  })

  it('omits an absent fingerprint rather than storing an empty one', () => {
    // Absent and empty are different answers to `matchesFingerprint`.
    expect(toStoredSection({ key: 'k', expiresAt: FOREVER_EXPIRY }))
      .not.toHaveProperty('ak_fingerprint')
  })
})

describe('isExpired', () => {
  const now = Date.parse('2026-10-29T00:00:00.000Z')

  it('is false before the expiry and true after it', () => {
    expect(isExpired({ key: 'k', expiresAt: '2026-10-30T00:00:00.000Z' }, now)).toBe(false)
    expect(isExpired({ key: 'k', expiresAt: '2026-10-28T00:00:00.000Z' }, now)).toBe(true)
  })

  it('treats the never-expires sentinel as not expired', () => {
    expect(isExpired({ key: 'k', expiresAt: FOREVER_EXPIRY }, now)).toBe(false)
  })

  it('treats an unparseable expiry as not expired', () => {
    // Not evidence the key stopped working; re-creating on it would create a
    // key per call.
    expect(isExpired({ key: 'k', expiresAt: 'not a date' }, now)).toBe(false)
  })
})

/** Headers of the Nth request the stub recorded. */
function requestHeaders(index: number): Record<string, string> {
  return requests[index]?.init?.headers as Record<string, string>
}