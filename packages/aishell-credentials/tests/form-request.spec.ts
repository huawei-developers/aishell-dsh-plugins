/**
 * The form-request envelope that travels the settings document.
 *
 * Two halves depend on this: the host writes a request, the browser reads it
 * and decides whether it is new. The token is the whole mechanism — without a
 * value that changes per request, a form the person cancelled could never be
 * reopened by a later call, because the browser would have no way to tell the
 * two requests apart.
 */

import { describe, it, expect } from 'vitest'
import {
  decodeRequest,
  encodeRequest,
  formRequest,
} from '../src/form-request.ts'

describe('formRequest', () => {
  it('mints a token alongside the session', () => {
    const { request } = formRequest('session-1')

    expect(request.sessionId).toBe('session-1')
    expect(request.token).not.toBe('')
  })

  it('mints a different token for every request', () => {
    // The browser compares tokens to decide "open again". Two requests sharing
    // one would look like a request already acted on, and the form a person
    // cancelled would never reappear.
    const first = formRequest('session-1').request.token
    const second = formRequest('session-1').request.token

    expect(second).not.toBe(first)
  })

  it('returns the encoded form for the settings document', () => {
    const { request, encoded } = formRequest('session-9')

    expect(decodeRequest(encoded)).toEqual(request)
  })
})

describe('encode/decode', () => {
  it('round-trips', () => {
    const request = { token: 't1', sessionId: 's1' }
    expect(decodeRequest(encodeRequest(request))).toEqual(request)
  })

  it('reads an empty field as no request', () => {
    // `''` is what the config defaults to, and what the host writes before any
    // request has been made.
    expect(decodeRequest(undefined)).toBeUndefined()
    expect(decodeRequest('')).toBeUndefined()
  })

  it('reads a corrupt field as no request', () => {
    // A corrupt value must show nothing. Opening a form bound to a session that
    // does not exist would put it in a conversation nobody is looking at.
    for (const raw of ['not json', 'null', '[]', '{}', '{"token":""}', '{"token":"t"}', '{"sessionId":"s"}']) {
      expect(decodeRequest(raw)).toBeUndefined()
    }
  })

  it('rejects a non-string field', () => {
    expect(decodeRequest('{"token":1,"sessionId":"s"}')).toBeUndefined()
    expect(decodeRequest('{"token":"t","sessionId":2}')).toBeUndefined()
  })
})