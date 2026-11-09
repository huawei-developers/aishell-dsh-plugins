/**
 * The credential body bound.
 *
 * `readJsonBody` states its limit in bytes, and the obvious implementation —
 * `text.length` — measures UTF-16 code units instead. The two agree on ASCII
 * and diverge by up to 3× on text, which is exactly the shape a bound must not
 * have: it would admit a body three times the size it claims to allow, and the
 * error would be a credential that parsed rather than one that was refused.
 *
 * The bound is reachable from here because `createCredentialRoutes` is the only
 * caller, and `save` answers `400` with the reason. No route is reached and no
 * store is touched on that path.
 */

import { describe, it, expect } from 'vitest'
import { createCredentialRoutes } from '../src/index.ts'
import { MemoryBackend } from '@huaweidevtools/aishell-dsh-credentials-store'

/** Routes over an empty store; the verifier is never reached on a rejected body. */
function routes() {
  return createCredentialRoutes({
    store: new MemoryBackend(),
    verify: () => { throw new Error('verification must not run for a rejected body') },
    recordStatus: () => {},
    hint: () => '',
    notifyChanged: () => {},
  })
}

/** A save POST carrying `body` as its raw text. */
function rawRequest(body: string): Request {
  return new Request('http://127.0.0.1:3080/api/aishell/credentials', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body,
  })
}

describe('credential body bound', () => {
  it('counts bytes, not UTF-16 code units', async () => {
    // Three-byte characters: `length` reports a third of the real size, so a
    // code-unit bound would wave this through. The body is valid JSON with the
    // two fields a save needs, so nothing else would reject it.
    const padding = '中'.repeat(4000) // 12 000 bytes, 4000 code units
    const body = JSON.stringify({ accessKeyId: 'AK', secretAccessKey: padding })
    const bytes = new TextEncoder().encode(body).length
    expect(body.length).toBeLessThan(bytes)
    expect(bytes).toBeGreaterThan(8 * 1024)

    const response = await routes().save(rawRequest(body))

    expect(response.status).toBe(400)
    expect((await response.json() as { error: string }).error).toMatch(/too large/i)
  })

  it('admits a body under the bound', async () => {
    // The control: the byte count must not reject ordinary payloads. A real
    // credential is well under 1 KiB.
    const body = JSON.stringify({ accessKeyId: 'AKIAEXAMPLE', secretAccessKey: 'sk-secret' })
    const response = await routes().save(rawRequest(body))

    // Not 400 — the request gets past the bound and reaches verification, which
    // this fixture makes throw so the two outcomes cannot be confused.
    expect(response.status).toBe(422)
  })
})