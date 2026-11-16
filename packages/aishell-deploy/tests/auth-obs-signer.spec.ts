/**
 * OBS request signing, as behaviour a caller can observe.
 *
 * The signature is opaque, so what these pin is the part that is decidable: the
 * whitelist that decides which query parameters enter CanonicalizedResource,
 * and the case handling around it. A param that should be signed and is not
 * produces a `403 SignatureDoesNotMatch` from the service, which is a failure
 * no test of the hash could ever see.
 */

import { describe, expect, it } from 'vitest'

import { signObsRequest } from '../src/auth-obs-signer.ts'

/** Sign one request and return the headers it produced. */
function signed(url: string, method = 'GET'): Record<string, string> {
  const headers: Record<string, string> = { Date: 'Tue, 01 Jan 2030 00:00:00 GMT' }
  signObsRequest({ method, url: new URL(url), headers, ak: 'AK', sk: 'SK', body: '' })
  return headers
}

describe('signObsRequest — the sub-resource whitelist', () => {
  it('signs a whitelisted sub-resource', () => {
    const plain = signed('https://bucket.obs.cn-north-4.myhuaweicloud.com/obj')
    const withAcl = signed('https://bucket.obs.cn-north-4.myhuaweicloud.com/obj?acl')
    // A different StringToSign means a different Authorization.
    expect(withAcl['Authorization']).not.toBe(plain['Authorization'])
  })

  it('ignores a parameter outside the whitelist', () => {
    // Non-whitelisted params must not enter the signature, or every request
    // carrying a cache-buster would fail against the service.
    const plain = signed('https://bucket.obs.cn-north-4.myhuaweicloud.com/obj')
    const noisy = signed('https://bucket.obs.cn-north-4.myhuaweicloud.com/obj?cachebuster=1')
    expect(noisy['Authorization']).toBe(plain['Authorization'])
  })

  it('recognises requestpayment in any casing', () => {
    // The whitelist is consulted after lowercasing the query key, so the set
    // holds the lowercased spelling — the SDK's source spells one entry
    // `requestPayment`, and copying that would produce a member that can never
    // match. Both spellings must be *signed*; they do not have to sign the
    // same, because the key itself is written back as it was received.
    const plain = signed('https://bucket.obs.cn-north-4.myhuaweicloud.com/obj')
    const lower = signed('https://bucket.obs.cn-north-4.myhuaweicloud.com/obj?requestpayment')
    const camel = signed('https://bucket.obs.cn-north-4.myhuaweicloud.com/obj?requestPayment')
    expect(lower['Authorization']).not.toBe(plain['Authorization'])
    expect(camel['Authorization']).not.toBe(plain['Authorization'])
  })

  it('writes the sub-resource key back in the casing it arrived in', () => {
    // Matching the SDK: it lowercases only to consult the whitelist, then
    // appends `key` as decoded. Signing a camel-cased key in lowercase would
    // disagree with the service's own StringToSign and earn a 403.
    const lower = signed('https://bucket.obs.cn-north-4.myhuaweicloud.com/obj?requestpayment')
    const camel = signed('https://bucket.obs.cn-north-4.myhuaweicloud.com/obj?requestPayment')
    expect(camel['Authorization']).not.toBe(lower['Authorization'])
  })

  it('signs position, which the whitelist names twice in the SDK source', () => {
    const plain = signed('https://bucket.obs.cn-north-4.myhuaweicloud.com/obj')
    const withPosition = signed('https://bucket.obs.cn-north-4.myhuaweicloud.com/obj?position=5')
    expect(withPosition['Authorization']).not.toBe(plain['Authorization'])
  })

  it('signs the sub-resources in one canonical order regardless of query order', () => {
    const a = signed('https://bucket.obs.cn-north-4.myhuaweicloud.com/obj?acl&versionid=1')
    const b = signed('https://bucket.obs.cn-north-4.myhuaweicloud.com/obj?versionid=1&acl')
    expect(a['Authorization']).toBe(b['Authorization'])
  })

  it('orders a bare flag before the same key carrying a value', () => {
    // The SDK sorts whole `key=value` strings; this sorts by key. The two agree
    // as long as the shorter string is the other's prefix, which it always is
    // for `k` beside `k=v` — and a set cannot hold one key twice. Pinned here
    // because the agreement is what keeps the port faithful, not the code shape.
    const a = signed('https://bucket.obs.cn-north-4.myhuaweicloud.com/obj?versioning&versionid=9')
    const b = signed('https://bucket.obs.cn-north-4.myhuaweicloud.com/obj?versionid=9&versioning')
    expect(a['Authorization']).toBe(b['Authorization'])
  })
})