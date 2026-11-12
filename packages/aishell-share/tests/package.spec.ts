/**
 * The share package: what travels, and what the importer assumes.
 *
 * The selection rules decide silently — an event either travels or it does not
 * — so the excluded kinds are asserted as explicitly as the included ones.
 */

import { describe, expect, it } from 'vitest'

import {
  buildPackage,
  carriesConversation,
  readPackage,
  selectEvents,
  toStoredEvents,
  type ShareEvent,
} from '../src/package.ts'

/** One stored event, shaped like a log entry. */
function stored(type: string, extra: Record<string, unknown> = {}): StoredLike {
  return { type, seq: 7, time: 1000, data: { kind: type }, ...extra }
}

/** A log entry, with the fields this suite reads. */
interface StoredLike {
  readonly type: string
  readonly seq: number
  readonly time: number
  readonly data: unknown
  readonly surfaceOp?: unknown
  readonly sourceEventSeqs?: unknown
  readonly ignorable?: true
}

describe('which events travel', () => {
  it('carries the messages and the tool pairing', () => {
    for (const type of ['user/message', 'assistant/message', 'tool/result', 'tool/call']) {
      expect(carriesConversation(type)).toBe(true)
    }
  })

  it('carries the turn and step boundaries', () => {
    for (const type of ['turn/start', 'turn/end', 'step/start', 'step/end']) {
      expect(carriesConversation(type)).toBe(true)
    }
  })

  it('leaves local-only state behind', () => {
    for (const type of [
      'compaction/start', 'compaction/end', 'approval/asked', 'job/registered',
      'subagent/catalog', 'hook/invoked', 'working-directory/change',
      'session-log-deepseek/delivery-accepted', 'todo/write',
    ]) {
      expect(carriesConversation(type)).toBe(false)
    }
  })
})

describe('selectEvents', () => {
  it('keeps order and drops excluded kinds', () => {
    const selected = selectEvents([
      stored('turn/start'),
      stored('compaction/start'),
      stored('user/message', { surfaceOp: 'append' }),
      stored('turn/end'),
    ])

    expect(selected.map((event) => event.type)).toEqual(['turn/start', 'user/message', 'turn/end'])
  })

  it('drops seq and time, which the importer assigns', () => {
    const [event] = selectEvents([stored('turn/start')])

    expect(event).not.toHaveProperty('seq')
    expect(event).not.toHaveProperty('time')
  })

  it('keeps the surface operation on a message', () => {
    const [event] = selectEvents([stored('user/message', { surfaceOp: 'append' })])

    expect(event?.surfaceOp).toBe('append')
  })

  it('keeps the ignorable marker when present', () => {
    const [event] = selectEvents([stored('turn/start', { ignorable: true })])
    expect(event?.ignorable).toBe(true)
  })
})

describe('references are re-anchored onto the carried events', () => {
  /**
   * A source log with a gap: `turn/start` at 0, a local-only event at 1, the
   * messages at 2 and 3, and a tool result at 5 citing the call at 3.
   */
  const log = (): StoredLike[] => [
    { type: 'turn/start', seq: 0, time: 1, data: { turn: 0 } },
    { type: 'approval/asked', seq: 1, time: 1, data: {} },
    { type: 'user/message', seq: 2, time: 1, data: {}, surfaceOp: 'append' },
    { type: 'tool/call', seq: 3, time: 1, data: {} },
    { type: 'turn/end', seq: 4, time: 1, data: {} },
    { type: 'tool/result', seq: 5, time: 1, data: {}, surfaceOp: 'append', sourceEventSeqs: [3] },
  ]

  it('translates a citation onto the position the cited event occupies', () => {
    const selected = selectEvents(log())

    // tool/call sat at source seq 3 and is the fourth carried event.
    expect(selected.map((event) => event.type)).toEqual([
      'turn/start', 'user/message', 'tool/call', 'turn/end', 'tool/result',
    ])
    expect(selected[4]?.sourceEventSeqs).toEqual([2])
  })

  it('drops a citation of an event that does not travel', () => {
    const selected = selectEvents([
      { type: 'approval/asked', seq: 0, time: 1, data: {} },
      { type: 'user/message', seq: 1, time: 1, data: {}, surfaceOp: 'append', sourceEventSeqs: [0] },
    ])

    // seq 0 is local-only state and did not travel, so there is no position to
    // point at.
    expect(selected[0]?.type).toBe('user/message')
    expect(selected[0]?.sourceEventSeqs).toBeUndefined()
  })

  it('translates a replace range onto the carried positions', () => {
    const selected = selectEvents([
      { type: 'user/message', seq: 0, time: 1, data: {}, surfaceOp: 'append' },
      { type: 'tool/call', seq: 1, time: 1, data: {} },
      { type: 'approval/asked', seq: 2, time: 1, data: {} },
      { type: 'tool/result', seq: 3, time: 1, data: {}, surfaceOp: 'append' },
      { type: 'tool/result', seq: 4, time: 1, data: {}, surfaceOp: { op: 'replace', startSeq: 3, endSeq: 3 }, sourceEventSeqs: [3] },
    ])

    // The replaced node sat at source seq 3 and is the third carried event.
    expect(selected[3]?.surfaceOp).toEqual({ op: 'replace', startSeq: 2, endSeq: 2 })
    expect(selected[3]?.sourceEventSeqs).toEqual([2])
  })

  it('degrades a replace whose shadowed events did not travel to an append', () => {
    const selected = selectEvents([
      { type: 'compaction/summary', seq: 0, time: 1, data: {} },
      { type: 'user/message', seq: 1, time: 1, data: {}, surfaceOp: { op: 'replace', startSeq: 0, endSeq: 0 } },
    ])

    // Nothing it shadowed is here, so there is no range to replace.
    expect(selected[0]?.surfaceOp).toBe('append')
  })
})

describe('session/title', () => {
  it('travels with its cited human message renumbered', () => {
    const selected = selectEvents([
      { type: 'user/message', seq: 4, time: 1, data: { source: { kind: 'user' } }, surfaceOp: 'append' },
      { type: 'session/title', seq: 5, time: 1, data: { title: 'A name', messageSeqs: [4], source: { kind: 'provider' } } },
    ])

    expect(selected.map((event) => event.type)).toEqual(['user/message', 'session/title'])
    expect((selected[1]?.data as { messageSeqs: number[] } | undefined)?.messageSeqs).toEqual([0])
  })

  it('travels on an explicit rename, which cites nothing', () => {
    const selected = selectEvents([
      stored('turn/start', { seq: 0 }),
      { type: 'session/title', seq: 1, time: 1, data: { title: 'Renamed', messageSeqs: [], source: { kind: 'user' } } },
    ])

    expect(selected.map((event) => event.type)).toEqual(['turn/start', 'session/title'])
  })

  it('drops an automatic title whose messages did not travel', () => {
    // The cited message was a runtime-context message, which is not carried:
    // an automatically sourced title needs a human `user/message` to name.
    const selected = selectEvents([
      { type: 'user/message', seq: 0, time: 1, data: { source: { kind: 'time-context' } }, surfaceOp: 'append' },
      { type: 'session/title', seq: 1, time: 1, data: { title: 'x', messageSeqs: [0], source: { kind: 'fallback' } } },
    ])

    expect(selected.map((event) => event.type)).toEqual(['user/message'])
  })
})

describe('buildPackage', () => {
  it('records the writer version and the session facts', () => {
    const pkg = buildPackage({
      title: 'A conversation',
      createdAt: 1700000000000,
      events: [stored('turn/start'), stored('user/message', { surfaceOp: 'append' })],
    }, '0.0.21')

    expect(pkg).toMatchObject({
      version: '0.0.21',
      title: 'A conversation',
      createdAt: 1700000000000,
    })
    expect(pkg.events).toHaveLength(2)
  })
})

describe('readPackage', () => {
  /** A minimal valid package. */
  const valid = { version: '0.0.21', title: 'x', createdAt: 1, events: [] }

  it('accepts a well-formed package', () => {
    expect(readPackage(valid)).toEqual(valid)
  })

  it('rejects a body that is not an object', () => {
    for (const value of [null, 42, 'text', []]) expect(readPackage(value)).toBeUndefined()
  })

  it('rejects a package missing a required field', () => {
    for (const key of ['version', 'title', 'createdAt', 'events']) {
      const copy = { ...valid } as Record<string, unknown>
      delete copy[key]
      expect(readPackage(copy)).toBeUndefined()
    }
  })

  it('rejects an event with no type', () => {
    expect(readPackage({ ...valid, events: [{ data: {} }] })).toBeUndefined()
    expect(readPackage({ ...valid, events: [{ type: '', data: {} }] })).toBeUndefined()
  })

  it('rejects an event that is not an object', () => {
    expect(readPackage({ ...valid, events: [42] })).toBeUndefined()
  })
})

describe('toStoredEvents', () => {
  it('numbers the sequence densely from zero', () => {
    const events: ShareEvent[] = [
      { type: 'turn/start', data: {} },
      { type: 'user/message', data: {}, surfaceOp: 'append' },
      { type: 'turn/end', data: {} },
    ]
    const rebuilt = toStoredEvents(events, 5000) as { seq: number }[]

    expect(rebuilt.map((event) => event.seq)).toEqual([0, 1, 2])
  })

  it('stamps one import time across the log', () => {
    const rebuilt = toStoredEvents([{ type: 'turn/start', data: {} }], 5000) as { time: number }[]
    expect(rebuilt[0]?.time).toBe(5000)
  })

  it('carries the surface fields through', () => {
    const events: ShareEvent[] = [{ type: 'user/message', data: {}, surfaceOp: 'append' }]
    const [rebuilt] = toStoredEvents(events, 1) as { surfaceOp?: unknown }[]

    expect(rebuilt?.surfaceOp).toBe('append')
  })
})