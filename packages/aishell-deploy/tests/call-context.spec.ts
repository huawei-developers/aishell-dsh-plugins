/**
 * The Session a call is made for.
 *
 * The gates read the mode by Session, and the signed-HTTP funnel is reached
 * several layers below the tool handler with no Session parameter to pass. What
 * these pin is that the Session survives that distance — and that it does not
 * leak past the call that set it, which would make one conversation's grant
 * answer for the next one's request.
 */

import { describe, it, expect } from 'vitest'

import { currentSession, runForSession, runWithoutSession } from '../src/permission/call-context.ts'

describe('call-context', () => {
  it('reads no Session outside a call', () => {
    expect(currentSession()).toBeUndefined()
  })

  it('carries the Session down a chain of awaits', async () => {
    // The distance that matters: a handler awaits a helper, which awaits
    // another, which signs the request. All of them are the same call.
    const seen: Array<string | undefined> = []
    const third = async (): Promise<void> => { seen.push(currentSession()) }
    const second = async (): Promise<void> => { await Promise.resolve(); await third() }
    const first = async (): Promise<void> => { await second(); seen.push(currentSession()) }

    await runForSession('s1', first)

    expect(seen).toEqual(['s1', 's1'])
  })

  it('keeps two concurrent calls apart', async () => {
    // Two Sessions' tool calls overlap routinely. Reading one's Session inside
    // the other's chain would refuse or admit the wrong request.
    const seen: Array<string | undefined> = []
    const call = async (): Promise<void> => {
      await Promise.resolve()
      await new Promise(resolve => setTimeout(resolve, 1))
      seen.push(currentSession())
    }

    await Promise.all([runForSession('s1', call), runForSession('s2', call)])

    expect(seen.sort()).toEqual(['s1', 's2'])
  })

  it('follows work the call schedules without awaiting it', async () => {
    // The store follows the async resource graph rather than only the `await`
    // chain: a request signed after a `setTimeout` in the handler still reads
    // the Session that handler ran for.
    const seen: Array<string | undefined> = []
    await runForSession('s1', async () => {
      setTimeout(() => { seen.push(currentSession()) }, 1)
      void Promise.resolve().then(() => { seen.push(currentSession()) })
      await Promise.resolve()
    })
    await new Promise(resolve => setTimeout(resolve, 20))

    expect(seen).toContain('s1')
    expect(seen.every(session => session === 's1')).toBe(true)
  })

  it('does not carry the Session past the call that set it', async () => {
    await runForSession('s1', async () => { await Promise.resolve() })
    expect(currentSession()).toBeUndefined()
  })

  it('returns what the call returned', () => {
    expect(runForSession('s1', () => 42)).toBe(42)
  })
})
describe('runWithoutSession', () => {
  it('gives a call no Session even inside another call', () => {
    // A call the harness gave no session must not borrow one from whatever is
    // already in scope: that would credit it to a conversation it is not part
    // of, and judge it by a mode nobody set for it.
    const seen: Array<string | undefined> = []
    runForSession('outer', () => {
      runWithoutSession(() => { seen.push(currentSession()) })
      seen.push(currentSession())
    })

    expect(seen).toEqual([undefined, 'outer'])
  })

  it('leaves the enclosing call intact afterwards', () => {
    let inside: string | undefined
    runForSession('outer', () => {
      runWithoutSession(() => {})
      inside = currentSession()
    })
    expect(inside).toBe('outer')
    expect(currentSession()).toBeUndefined()
  })
})
