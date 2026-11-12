/**
 * Where a per-message share cuts the log.
 *
 * The rule this pins is the one that made the feature possible at all: a cut
 * lands on a Turn's end, never on the message. Both halves are asserted — that
 * a message is found and cut where its Turn closes, and that everything the cut
 * would break is refused rather than shared whole.
 */

import { describe, expect, it } from 'vitest'

import { cutForMessage, keepThrough } from '../src/truncate.ts'

/** One log entry, shaped like the store's. */
interface Entry {
  readonly type: string
  readonly seq: number
  readonly data?: unknown
}

/**
 * A log shaped like a real one: a Turn interleaves its messages with steps.
 *
 * ```
 *  5 turn/start(1)     10 tool/result
 *  7 step/start          11 step/end
 *  9 user/message(u1)    13 turn/end(1)
 * 18 assistant/message(a1)
 * ```
 */
const LOG: readonly Entry[] = [
  { type: 'turn/start', seq: 5, data: { turn: 1 } },
  { type: 'step/start', seq: 7, data: { turn: 1, step: 1 } },
  { type: 'user/message', seq: 9, data: { id: 'u1', role: 'user' } },
  { type: 'assistant/message', seq: 18, data: { turn: 1, step: 1, message: { id: 'a1' } } },
  { type: 'tool/call', seq: 19, data: { turn: 1, step: 1, callId: 'c1' } },
  { type: 'tool/result', seq: 20, data: { turn: 1, step: 1, message: { id: 't1' } } },
  { type: 'step/end', seq: 21, data: { turn: 1, step: 1 } },
  { type: 'turn/end', seq: 23, data: { turn: 1 } },
  { type: 'turn/start', seq: 25, data: { turn: 2 } },
]

describe('cutForMessage', () => {
  it('cuts at the end of the Turn the message belongs to', () => {
    expect(cutForMessage(LOG, 'a1')).toEqual({ ok: true, lastSeq: 23 })
  })

  it('cuts a user message at the same Turn end, not at the message', () => {
    // The message sits at seq 9; the Turn closes at 23. Cutting at 9 would drop
    // the step/end the step/start needs.
    expect(cutForMessage(LOG, 'u1')).toEqual({ ok: true, lastSeq: 23 })
  })

  it('reads the nested id of an assistant message', () => {
    // `assistant/message` keeps the message under `data.message`; `user/message`
    // puts the id at `data.id`. A reader that knew only one shape would miss
    // half the log.
    expect(cutForMessage(LOG, 'a1').ok).toBe(true)
  })

  it('does not cut at a Turn that has not closed', () => {
    const open = LOG.filter((event) => event.seq < 23)
    expect(cutForMessage(open, 'a1')).toEqual({ ok: false, reason: 'turn-not-complete' })
  })

  it('does not cut when the message is not in the log', () => {
    expect(cutForMessage(LOG, 'nope')).toEqual({ ok: false, reason: 'message-not-found' })
  })

  it('does not cut a message whose event names no Turn', () => {
    const nameless: readonly Entry[] = [
      { type: 'user/message', seq: 1, data: { id: 'u9', role: 'user' } },
      { type: 'turn/end', seq: 5, data: {} },
    ]
    expect(cutForMessage(nameless, 'u9')).toEqual({ ok: false, reason: 'turn-not-complete' })
  })

  it('ignores an earlier Turn with the same number', () => {
    // The boundary is the first `turn/end` at or after the message. A log that
    // reused a number must not cut backwards.
    const reused: readonly Entry[] = [
      { type: 'turn/end', seq: 2, data: { turn: 1 } },
      { type: 'turn/start', seq: 3, data: { turn: 1 } },
      { type: 'assistant/message', seq: 6, data: { turn: 1, message: { id: 'a2' } } },
      { type: 'turn/end', seq: 9, data: { turn: 1 } },
    ]
    expect(cutForMessage(reused, 'a2')).toEqual({ ok: true, lastSeq: 9 })
  })
})

describe('keepThrough', () => {
  it('keeps the cut and everything before it', () => {
    const kept = keepThrough(LOG, 23)
    expect(kept.map((event) => event.seq)).toEqual([5, 7, 9, 18, 19, 20, 21, 23])
  })

  it('keeps an empty prefix when the cut precedes every event', () => {
    expect(keepThrough(LOG, 0)).toEqual([])
  })
})