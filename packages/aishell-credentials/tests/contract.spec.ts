/**
 * The aishell-auth contract client.
 *
 * Two things are worth pinning here, and they are different in kind.
 *
 * **The mapping** is pure and total: a provider's `credential_schema` decides
 * which payload field becomes the access key, and a payload that does not
 * satisfy the schema yields nothing rather than half a pair. Getting this
 * wrong stores a credential that fails later at the gateway, pointing nowhere
 * near the cause.
 *
 * **The refusals** are the client's contract with the rest of the plugin: an
 * unreachable service, a rejected redirect URI, or a delivery mode this plugin
 * cannot complete must each surface as a throw, because the caller's response
 * to all three is the same — do not offer the entry — and a caller that
 * received `undefined` instead would have to guess which.
 */

import { describe, it, expect, vi } from 'vitest'
import {
  AuthContractError,
  findProvider,
  mapCredential,
  requestLogin,
  type ProviderInfo,
} from '../src/out-of-band/contract.ts'

/** The provider the live service reports, verbatim. */
const HUAWEI: ProviderInfo = {
  id: 'huaweicloud',
  display_name: '华为云',
  delivery: 'out_of_band',
  credential_type: 'ak_sk_sts',
  credential_schema: { access: 'string', secret: 'string', securitytoken: 'string' },
}

/** A response carrying a JSON body. */
function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

/** A fetch stub answering one fixed response. */
function stubFetch(response: Response | (() => never)): typeof fetch {
  return (() => typeof response === 'function'
    ? Promise.reject(response())
    : Promise.resolve(response)) as unknown as typeof fetch
}

describe('mapCredential — the provider schema decides the field names', () => {
  it('maps the shipped provider schema', () => {
    expect(mapCredential(HUAWEI.credential_schema, {
      access: 'AK',
      secret: 'SK',
      securitytoken: 'TOKEN',
    })).toEqual({ accessKeyId: 'AK', secretAccessKey: 'SK', securityToken: 'TOKEN' })
  })

  it('maps a schema that spells the fields differently', () => {
    // The point of reading the schema: a provider whose names differ still
    // lands in the right slots, with no change here.
    expect(mapCredential({ accessKeyId: 'string', secretAccessKey: 'string' }, {
      accessKeyId: 'AK',
      secretAccessKey: 'SK',
    })).toEqual({ accessKeyId: 'AK', secretAccessKey: 'SK' })
    expect(mapCredential({ access_key: 'string', secret_key: 'string' }, {
      access_key: 'AK',
      secret_key: 'SK',
    })).toEqual({ accessKeyId: 'AK', secretAccessKey: 'SK' })
  })

  it('omits an empty token rather than passing an empty string', () => {
    // An empty `security_token` would sign as a third header the gateway then
    // rejects — the same rule the credential store applies.
    const mapped = mapCredential(HUAWEI.credential_schema, {
      access: 'AK',
      secret: 'SK',
      securitytoken: '',
    })
    expect(mapped).not.toHaveProperty('securityToken')
  })

  it('omits a token the payload does not carry', () => {
    const mapped = mapCredential(HUAWEI.credential_schema, { access: 'AK', secret: 'SK' })
    expect(mapped).not.toHaveProperty('securityToken')
  })

  it('yields nothing when the payload lacks a field the schema promises', () => {
    // Half a pair is not a credential: storing it would leave the store in a
    // state the person cannot see and no verifier would accept.
    expect(mapCredential(HUAWEI.credential_schema, { access: 'AK' })).toBeUndefined()
    expect(mapCredential(HUAWEI.credential_schema, { secret: 'SK' })).toBeUndefined()
    expect(mapCredential(HUAWEI.credential_schema, {})).toBeUndefined()
  })

  it('yields nothing when a promised field arrives empty or not a string', () => {
    expect(mapCredential(HUAWEI.credential_schema, { access: '', secret: 'SK' })).toBeUndefined()
    expect(mapCredential(HUAWEI.credential_schema, { access: 42, secret: 'SK' })).toBeUndefined()
  })

  it('yields nothing when the schema names no access or secret field', () => {
    expect(mapCredential({ somethingelse: 'string' }, { somethingelse: 'X' })).toBeUndefined()
  })
})

describe('listProviders / findProvider', () => {
  it('finds a provider the service lists', async () => {
    const found = await findProvider('huaweicloud', {
      fetch: stubFetch(jsonResponse({ providers: [HUAWEI] })),
    })
    expect(found).toEqual(HUAWEI)
  })

  it('answers undefined for a provider the service does not list', async () => {
    const found = await findProvider('nope', {
      fetch: stubFetch(jsonResponse({ providers: [HUAWEI] })),
    })
    expect(found).toBeUndefined()
  })

  it('throws with the service words when it is unreachable', async () => {
    // The caller's response to all three failures is the same — do not offer
    // the entry — so each must be a throw rather than a value to interpret.
    await expect(findProvider('huaweicloud', {
      fetch: stubFetch(() => { throw new Error('getaddrinfo ENOTFOUND') }),
    })).rejects.toThrow(AuthContractError)
  })

  it('throws with the service message on an error response', async () => {
    await expect(findProvider('huaweicloud', {
      fetch: stubFetch(jsonResponse(
        { error_code: 'AISHELL.1011', error_msg: 'provider not registered' },
        404,
      )),
    })).rejects.toThrow(/provider not registered \(AISHELL\.1011\)/)
  })
})

describe('requestLogin', () => {
  /** The login target the live service returns, verbatim. */
  const TARGET = {
    provider: 'huaweicloud',
    delivery: 'out_of_band',
    login_url: 'https://devstation.connect.huaweicloud.com/space/auth/redirect?callback=39821',
    callback: {
      address: '127.0.0.1:39821',
      path: '/',
      method: 'POST',
      content_type: 'application/json',
      allow_origins: ['https://devstation.connect.huaweicloud.com'],
      requires_private_network_access: true,
      correlation: 'none',
    },
    expires_in: 600,
  }

  it('returns the target the service describes', async () => {
    const target = await requestLogin('huaweicloud', 'http://127.0.0.1:39821/', {
      fetch: stubFetch(jsonResponse(TARGET)),
    })
    expect(target).toEqual(TARGET)
  })

  it('carries the redirect URI verbatim in the query', async () => {
    let seen = ''
    await requestLogin('huaweicloud', 'http://127.0.0.1:39821/', {
      fetch: ((input: string | URL | Request) => {
        seen = String(input)
        return Promise.resolve(jsonResponse(TARGET))
      }) as unknown as typeof fetch,
    })
    // The service validates the URI and answers 400 for one it cannot project;
    // sending anything else would make that check meaningless.
    expect(seen).toContain(`redirect_uri=${encodeURIComponent('http://127.0.0.1:39821/')}`)
  })

  it('throws when the service omits the login URL', async () => {
    await expect(requestLogin('huaweicloud', 'http://127.0.0.1:1/', {
      fetch: stubFetch(jsonResponse({ ...TARGET, login_url: '' })),
    })).rejects.toThrow(/login_url/)
  })

  it('throws for a delivery this plugin cannot complete', async () => {
    // Failing here is the point: a listener started for a mode that cannot
    // finish would surface as a timeout with no explanation.
    await expect(requestLogin('huaweicloud', 'http://127.0.0.1:1/', {
      fetch: stubFetch(jsonResponse({ ...TARGET, delivery: 'brokered' })),
    })).rejects.toThrow(/brokered/)
  })

  it('throws when the body is not JSON', async () => {
    await expect(requestLogin('huaweicloud', 'http://127.0.0.1:1/', {
      fetch: stubFetch(new Response('<html>gateway</html>', { status: 200 })),
    })).rejects.toThrow(/not JSON/)
  })

  it('does not throw on a service that omits requires_private_network_access', async () => {
    // An older service omits it; that must read as false, not as a failure.
    const { requires_private_network_access: _omitted, ...callback } = TARGET.callback
    const target = await requestLogin('huaweicloud', 'http://127.0.0.1:39821/', {
      fetch: stubFetch(jsonResponse({ ...TARGET, callback })),
    })
    expect(target.callback.requires_private_network_access).toBeUndefined()
  })

  it('is exercised with a real Response, so the stubs above stay honest', () => {
    expect(vi.isMockFunction(stubFetch(jsonResponse({})))).toBe(false)
  })
})
