/**
 * The route's retry policy, and the failure classification it depends on.
 *
 * Two facts have to hold together for a 429 to be retried at all:
 *
 *   1. The adapter reports a rate limit with the code the policy names. It
 *      used to report every non-2xx as `PROVIDER_ERROR`, which is not in the
 *      retryable set — so the executor had nothing to act on.
 *   2. The policy actually lists that code, with a bounded ladder.
 *
 * Either alone does nothing. These pin both, and the ladder the user sees:
 * the chat UI renders the scheduled delay, so the numbers here are the
 * numbers on screen.
 */

import { describe, it, expect } from 'vitest'
import { GatewayAdapter } from '../src/adapter.ts'
import { MemoryBackend } from '@huaweidevtools/aishell-dsh-credentials-store'

/** An adapter over an empty store; nothing here makes a request. */
function makeAdapter(): GatewayAdapter {
  return new GatewayAdapter({
    resolveBaseUrl: () => 'https://gateway.example.com/v1',
    keyring: new MemoryBackend(),
    resolveImageBudget: () => ({ maxPixels: 1_000_000, maxBytes: 1_000_000 }),
    resolveMaxRequestImageBytes: () => 20_000_000,
  })
}

describe('retry policy', () => {
  it('allows five retries after the first attempt', () => {
    const policy = makeAdapter().providerRetryPolicy('aishell')
    expect(policy.mode).toBe('normal')
    // Narrowed rather than cast: the union has an `always` arm with no budget
    // at all, and asserting on it there would be asserting on a field the
    // shape does not have.
    if (policy.mode !== 'normal') throw new Error('expected a normal policy')
    expect(policy.maxRetries).toBe(5)
  })

  it('backs off 1, 2, 4, 8, 16 seconds', () => {
    // `localDelay` is `initialDelayMs * 2 ** (retry - 1)`, capped at
    // `maxDelayMs`. The cap equals the fifth rung, so the ladder ends exactly
    // where the policy intends rather than being flattened.
    const policy = makeAdapter().providerRetryPolicy('aishell')
    expect(policy.initialDelayMs).toBe(1_000)
    expect(policy.maxDelayMs).toBe(16_000)
    const delays = [1, 2, 3, 4, 5].map(retry =>
      Math.min(policy.initialDelayMs * 2 ** (retry - 1), policy.maxDelayMs))
    expect(delays).toEqual([1_000, 2_000, 4_000, 8_000, 16_000])
  })

  it('does not jitter', () => {
    // The chat UI renders the scheduled delay as a countdown. Jitter would
    // make the number on screen disagree with the delay actually waited.
    const policy = makeAdapter().providerRetryPolicy('aishell')
    expect(policy.jitterRatio).toBe(0)
  })

  it('retries the transient codes and not the request-shaped ones', () => {
    const policy = makeAdapter().providerRetryPolicy('aishell')
    if (policy.mode !== 'normal') throw new Error('expected a normal policy')
    expect([...policy.retryableCodes].sort()).toEqual(
      ['EMPTY_RESPONSE', 'RATE_LIMIT', 'SERVER', 'TIMEOUT', 'TRANSPORT'],
    )
    // A 4xx that is not a rate limit says the request itself is wrong; a retry
    // returns the same rejection. A retry cannot conjure a credential either.
    expect(policy.retryableCodes).not.toContain('PROVIDER_ERROR')
    expect(policy.retryableCodes).not.toContain('MISSING_CREDENTIAL')
    expect(policy.retryableCodes).not.toContain('INVALID_CREDENTIAL')
  })
})

describe('HTTP failure classification', () => {
  /**
   * Drive one request and return the code its rejection carried.
   *
   * The classification is not exported, so it is asserted where it is used:
   * the code on the error the stream raises.
   */
  async function codeFor(status: number): Promise<string> {
    const keyring = new MemoryBackend()
    keyring.set('HW_ACCESS_KEY', 'ak')
    keyring.set('HW_SECRET_KEY', 'sk')
    const adapter = new GatewayAdapter({
      resolveBaseUrl: () => 'https://gateway.example.com/v1',
      keyring,
      resolveImageBudget: () => ({ maxPixels: 1_000_000, maxBytes: 1_000_000 }),
      resolveMaxRequestImageBytes: () => 20_000_000,
    })
    globalThis.fetch = (async () => new Response('{}', { status })) as typeof fetch
    const options = {
      model: 'trial',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
    } as never
    try {
      for await (const _ of adapter.stream(options)) { void _ }
      throw new Error('expected the request to fail')
    } catch (error) {
      return (error as { code?: string }).code ?? 'none'
    }
  }

  it('reports 429 as RATE_LIMIT', async () => {
    // The one status the whole feature hinges on: a rate limit is the gateway
    // explicitly asking for a later attempt.
    expect(await codeFor(429)).toBe('RATE_LIMIT')
  })

  it('reports 5xx as SERVER', async () => {
    expect(await codeFor(500)).toBe('SERVER')
    expect(await codeFor(503)).toBe('SERVER')
  })

  it('reports 408 as TIMEOUT', async () => {
    expect(await codeFor(408)).toBe('TIMEOUT')
  })

  it('reports other 4xx as PROVIDER_ERROR, which the policy does not retry', async () => {
    // The direction that matters: a bad model id or a malformed body must not
    // cost five more identical requests.
    expect(await codeFor(400)).toBe('PROVIDER_ERROR')
    expect(await codeFor(401)).toBe('PROVIDER_ERROR')
    expect(await codeFor(404)).toBe('PROVIDER_ERROR')
  })

  it('reports a failed round trip as TRANSPORT, which the policy retries', async () => {
    // The code has to be the harness's own spelling. `TRANSPORT` is what the
    // default retryable set lists and what the shipped adapters raise; a
    // locally invented name would leave this route as the one place a network
    // fault is never retried.
    const keyring = new MemoryBackend()
    keyring.set('HW_ACCESS_KEY', 'ak')
    keyring.set('HW_SECRET_KEY', 'sk')
    const adapter = new GatewayAdapter({
      resolveBaseUrl: () => 'https://gateway.example.com/v1',
      keyring,
      resolveImageBudget: () => ({ maxPixels: 1_000_000, maxBytes: 1_000_000 }),
      resolveMaxRequestImageBytes: () => 20_000_000,
    })
    globalThis.fetch = (async () => { throw new TypeError('fetch failed') }) as typeof fetch

    let code: string | undefined
    try {
      for await (const _ of adapter.stream({
        model: 'trial',
        messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
      } as never)) { void _ }
    } catch (error) {
      code = (error as { code?: string }).code
    }

    expect(code).toBe('TRANSPORT')
    const policy = adapter.providerRetryPolicy('aishell')
    if (policy.mode !== 'normal') throw new Error('expected a normal policy')
    expect(policy.retryableCodes).toContain(code)
  })
})