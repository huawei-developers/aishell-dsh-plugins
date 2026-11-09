/**
 * Credential route behavior.
 *
 * The security-relevant contract these pin: a credential that fails IAM
 * verification never reaches the store, and no response body ever carries a
 * secret. Both are the reason the routes exist rather than a settings write —
 * so they are asserted directly on the `Response` the browser would receive.
 */

import { describe, it, expect, vi } from 'vitest'
import { createCredentialRoutes, type CredentialRoutesDeps } from '../src/index.ts'
import { MemoryBackend } from '@huaweidevtools/aishell-dsh-credentials-store'
import { readStoredPair } from '@huaweidevtools/aishell-dsh-credentials-store/accounts'

/** In-memory store standing in for the keyring. */
function makeStore(): MemoryBackend {
  return new MemoryBackend()
}

/** Routes bound to a fresh store, with the given verifier. */
function setup(verify: CredentialRoutesDeps['verify']): {
  routes: ReturnType<typeof createCredentialRoutes>
  store: MemoryBackend
  statusWrites: Parameters<CredentialRoutesDeps['recordStatus']>[0][]
  /** Counts `aishell/credentials-updated` announcements the routes made. */
  changes: Readonly<{ count: number }>
} {
  const store = makeStore()
  const statusWrites: Parameters<CredentialRoutesDeps['recordStatus']>[0][] = []
  const changes = { count: 0 }
  const routes = createCredentialRoutes({
    store,
    verify,
    recordStatus: (ops) => { statusWrites.push(ops) },
    hint: () => store.get('HW_ACCOUNT_HINT') ?? '',
    notifyChanged: () => { changes.count += 1 },
  })
  return { routes, store, statusWrites, changes }
}

/** A POST Request carrying the given JSON body for a save. */
function saveRequest(body: unknown): Request {
  return new Request('http://127.0.0.1:3080/api/aishell/credentials', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

const GOOD = { accessKeyId: 'AKIAEXAMPLE', secretAccessKey: 'sk-example-secret' }

describe('credential routes — save', () => {
  it('stores the verified set and answers with the account name', async () => {
    const { routes, store } = setup(() => Promise.resolve('hwc_gaoyusheng'))

    const response = await routes.save(saveRequest(GOOD))
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(body).toEqual({ ok: true, accountName: 'hwc_gaoyusheng' })
    expect(readStoredPair(store)).toEqual({
      ak: GOOD.accessKeyId,
      sk: GOOD.secretAccessKey,
    })
  })

  it('stores nothing when verification rejects, and reports the reason', async () => {
    const { routes, store, statusWrites } = setup(() => Promise.reject(new Error('verification failed: 401')))

    const response = await routes.save(saveRequest(GOOD))
    const body = await response.json()

    expect(response.status).toBe(422)
    expect(body.ok).toBe(false)
    expect(body.error).toContain('401')
    // The whole point: a rejected credential must not reach the store.
    expect(readStoredPair(store)).toBeUndefined()
    expect(statusWrites.flat().some(op => op.op === 'set' && op.path[0] === 'lastError')).toBe(true)
  })

  it('announces the change only when the store actually changed', async () => {
    const { routes, changes } = setup(() => Promise.resolve('account'))

    await routes.save(saveRequest(GOOD))
    expect(changes.count).toBe(1)

    // A counter of its own, so the assertion below is about the rejecting
    // routes rather than a shared total that either route could have moved.
    let rejectingNotified = 0
    const rejecting = createCredentialRoutes({
      store: makeStore(),
      verify: () => Promise.reject(new Error('nope')),
      recordStatus: () => {},
      hint: () => '',
      notifyChanged: () => { rejectingNotified += 1 },
    })
    // A rejected save touched nothing, so no consumer should be told to rebuild.
    await rejecting.save(saveRequest(GOOD))
    expect(rejectingNotified).toBe(0)
    expect(changes.count).toBe(1)
  })

  it('keeps an existing credential intact when a later save is rejected', async () => {
    const { routes, store } = setup(() => Promise.resolve('account'))
    await routes.save(saveRequest(GOOD))

    const failing = createCredentialRoutes({
      store,
      verify: () => Promise.reject(new Error('nope')),
      recordStatus: () => {},
      hint: () => '',
      notifyChanged: () => {},
    })
    await failing.save(saveRequest({ accessKeyId: 'BAD', secretAccessKey: 'bad' }))

    expect(readStoredPair(store)).toEqual({
      ak: GOOD.accessKeyId,
      sk: GOOD.secretAccessKey,
    })
  })

  it('replaces both halves together, and drops a token the new set omits', async () => {
    const { routes, store } = setup(() => Promise.resolve('account'))
    await routes.save(saveRequest({ ...GOOD, securityToken: 'sts-token' }))
    expect(readStoredPair(store)?.securityToken).toBe('sts-token')

    await routes.save(saveRequest({ accessKeyId: 'AK2', secretAccessKey: 'sk2' }))

    // One write replaces the whole pair, so the token cannot survive into a set
    // that did not carry one.
    expect(readStoredPair(store)).toEqual({ ak: 'AK2', sk: 'sk2' })
  })

  it('rejects a body missing either secret without calling the verifier', async () => {
    const verify = vi.fn(() => Promise.resolve('account'))
    const { routes, store } = setup(verify)

    const response = await routes.save(saveRequest({ accessKeyId: 'only-ak' }))

    expect(response.status).toBe(400)
    expect(verify).not.toHaveBeenCalled()
    expect(readStoredPair(store)).toBeUndefined()
  })

  it('rejects a malformed body with 400', async () => {
    const { routes } = setup(() => Promise.resolve('account'))

    const response = await routes.save(new Request('http://127.0.0.1:3080/api/aishell/credentials', {
      method: 'POST',
      body: 'not json',
    }))

    expect(response.status).toBe(400)
  })
})

describe('credential routes — status and clear', () => {
  it('never returns a secret in the status view', async () => {
    const { routes } = setup(() => Promise.resolve('hwc_gaoyusheng'))
    await routes.save(saveRequest({ ...GOOD, securityToken: 'sts-token' }))

    const response = await routes.get()
    const text = await response.text()

    expect(response.status).toBe(200)
    // The view has no slot a secret could ride in; assert the bytes.
    expect(text).not.toContain(GOOD.accessKeyId)
    expect(text).not.toContain(GOOD.secretAccessKey)
    expect(text).not.toContain('sts-token')
  })

  it('never returns a secret on the save response either', async () => {
    const { routes } = setup(() => Promise.resolve('hwc_gaoyusheng'))

    const response = await routes.save(saveRequest({ ...GOOD, securityToken: 'sts-token' }))
    const text = await response.text()

    expect(text).not.toContain(GOOD.accessKeyId)
    expect(text).not.toContain(GOOD.secretAccessKey)
    expect(text).not.toContain('sts-token')
  })

  it('reports configured once both halves are stored', async () => {
    const { routes } = setup(() => Promise.resolve('account'))
    expect((await (await routes.get()).json()).configured).toBe(false)

    await routes.save(saveRequest(GOOD))

    expect((await (await routes.get()).json()).configured).toBe(true)
  })

  it('clear removes every entry and lowers the status', async () => {
    const { routes, store, statusWrites } = setup(() => Promise.resolve('account'))
    await routes.save(saveRequest({ ...GOOD, securityToken: 'sts-token' }))

    const response = await routes.clear()

    expect(response.status).toBe(200)
    // The whole record goes: a token left behind would be inherited by the
    // next pair.
    expect(readStoredPair(store)).toBeUndefined()
    expect(store.get('aishell-credential')).toBeUndefined()
    expect((await (await routes.get()).json()).configured).toBe(false)
    expect(statusWrites.flat().some(op => op.op === 'set' && op.path[0] === 'credentialsStored' && op.value === false)).toBe(true)
  })

  it('answers a refused clear as JSON, and leaves the status alone', async () => {
    // The store can refuse a delete: a locked keyring rejects them, and an
    // unreadable encrypted file cannot be rewritten. Letting that escape would
    // reach the browser as a transport failure with no body, and the card would
    // say "could not reach the host" over a credential that is still stored.
    //
    // So the refusal has to arrive as a rendered verdict, with the status still
    // `configured` — that is the whole difference between "cleared" and "did
    // not clear", and the card shows it.
    const statusWrites: Parameters<CredentialRoutesDeps['recordStatus']>[0][] = []
    const announcements = { count: 0 }
    // A store whose deletes are refused the way a locked keyring refuses them.
    const store = new MemoryBackend()
    store.delete = () => { throw new Error('Secret Service: no result found') }
    const failing = createCredentialRoutes({
      store,
      verify: () => Promise.resolve('account'),
      recordStatus: (ops) => { statusWrites.push(ops) },
      hint: () => '',
      notifyChanged: () => { announcements.count += 1 },
    })

    const response = await failing.clear()
    const body = await response.json() as { ok: boolean, error?: string }

    expect(response.status).toBe(500)
    expect(body.ok).toBe(false)
    expect(body.error).toMatch(/no result found/)
    // The status was not lowered, and no "changed" was announced: nothing
    // changed.
    expect(statusWrites.flat().some(op => op.op === 'set' && op.path[0] === 'credentialsStored')).toBe(false)
    expect(announcements.count).toBe(0)
    // And the failure is recorded where the form reads it, so the card shows
    // the reason rather than a generic failure.
    expect(statusWrites.flat().some(op => op.op === 'set' && op.path[0] === 'lastError')).toBe(true)
  })
})
