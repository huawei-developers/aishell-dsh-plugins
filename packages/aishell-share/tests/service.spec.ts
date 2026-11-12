/**
 * The share service calls, against a stub `fetch`.
 *
 * What matters here is the mapping from an HTTP outcome to something a dialog
 * can say, and that the request carries what the service expects — the gzip
 * body included, since a plain JSON body would be refused in production and
 * this is the only place that decides.
 */

import { afterEach, describe, expect, it } from 'vitest'

import { createShare, readShare } from '../src/service.ts'

/** A recorded request. */
interface Recorded {
  readonly url: string
  readonly init: RequestInit | undefined
}

const ORIGIN = 'https://share.example.test'
const realFetch = globalThis.fetch
let recorded: Recorded[] = []

/**
 * Install a stub answering every request with one response.
 *
 * @param status - the response status.
 * @param body - the response body text.
 */
function stub(status: number, body = ''): void {
  recorded = []
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    recorded.push({ url: String(input), init })
    return new Response(body, { status })
  }) as typeof fetch
}

afterEach(() => {
  globalThis.fetch = realFetch
})

describe('createShare', () => {
  it('posts the package to the session endpoint', async () => {
    stub(201, JSON.stringify({ url: 'aishell://share/session/abc' }))

    const result = await createShare(ORIGIN, '{"title":"x"}')

    expect(result).toEqual({ ok: true, value: { url: 'aishell://share/session/abc' } })
    expect(recorded[0]?.url).toBe(`${ORIGIN}/share/session`)
    expect(recorded[0]?.init?.method).toBe('POST')
  })

  it('sends the body gzipped, which is what the service reads', async () => {
    stub(201, JSON.stringify({ url: 'aishell://share/session/abc' }))

    await createShare(ORIGIN, JSON.stringify({ title: 'a conversation' }))

    const headers = recorded[0]?.init?.headers as Record<string, string>
    expect(headers['content-encoding']).toBe('gzip')
    expect(headers['content-type']).toBe('application/json')

    // The body must decompress back to the JSON that was passed in.
    const body = recorded[0]?.init?.body as ArrayBuffer
    const text = await new Response(
      new Blob([body]).stream().pipeThrough(new DecompressionStream('gzip')),
    ).text()
    expect(JSON.parse(text)).toEqual({ title: 'a conversation' })
  })

  it('reports a response with no url as rejected', async () => {
    stub(201, JSON.stringify({}))
    expect(await createShare(ORIGIN, '{}')).toEqual({ ok: false, reason: 'rejected' })
  })

  it('maps a bad request to rejected', async () => {
    stub(400)
    expect(await createShare(ORIGIN, '{}')).toEqual({ ok: false, reason: 'rejected' })
  })

  it('maps an oversized package to too-large', async () => {
    stub(413)
    expect(await createShare(ORIGIN, '{}')).toEqual({ ok: false, reason: 'too-large' })
  })

  it('maps a server fault to unavailable-service', async () => {
    stub(503)
    expect(await createShare(ORIGIN, '{}')).toEqual({ ok: false, reason: 'unavailable-service' })
  })

  it('reports an unreachable service rather than throwing', async () => {
    globalThis.fetch = (async () => { throw new TypeError('network down') }) as typeof fetch
    expect(await createShare(ORIGIN, '{}')).toEqual({ ok: false, reason: 'unavailable-service' })
  })
})

describe('readShare', () => {
  it('gets the package by id', async () => {
    stub(200, '{"title":"x"}')

    const result = await readShare(ORIGIN, 'abc')

    expect(result).toEqual({ ok: true, value: '{"title":"x"}' })
    expect(recorded[0]?.url).toBe(`${ORIGIN}/share/session/abc`)
    expect(recorded[0]?.init?.method).toBe('GET')
  })

  it('encodes an id that would otherwise change the path', async () => {
    stub(200, '{}')

    await readShare(ORIGIN, 'a/b c')

    expect(recorded[0]?.url).toBe(`${ORIGIN}/share/session/a%2Fb%20c`)
  })

  it('maps a missing share to unavailable', async () => {
    stub(404)
    expect(await readShare(ORIGIN, 'abc')).toEqual({ ok: false, reason: 'unavailable' })
  })

  it('maps a withdrawn share to unavailable', async () => {
    stub(410)
    expect(await readShare(ORIGIN, 'abc')).toEqual({ ok: false, reason: 'unavailable' })
  })

  it('reports an unreachable service rather than throwing', async () => {
    globalThis.fetch = (async () => { throw new TypeError('network down') }) as typeof fetch
    expect(await readShare(ORIGIN, 'abc')).toEqual({ ok: false, reason: 'unavailable-service' })
  })
})