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

describe('the surface head', () => {
  /** A system message as the log stores it: the rendered prompt. */
  const head = (seq: number, text = 'rendered prompt', op: unknown = 'append'): StoredLike => ({
    type: 'system/message',
    seq,
    time: 1,
    surfaceOp: op,
    data: {
      turn: 1,
      step: 1,
      message: { role: 'system', content: [{ type: 'text', text }], source: { kind: 'system-prompt' }, id: `head-${seq}` },
    },
  })

  /** The events that open a conversation, up to its first user message. */
  const opening = (): StoredLike[] => [
    { type: 'turn/start', seq: 0, time: 1, data: { turn: 1 } },
    { type: 'step/start', seq: 1, time: 1, data: { turn: 1, step: 1 } },
    head(2),
    { type: 'user/message', seq: 3, time: 1, data: { source: { kind: 'user' } }, surfaceOp: 'append' },
    { type: 'step/end', seq: 4, time: 1, data: { turn: 1, step: 1 } },
    { type: 'turn/end', seq: 5, time: 1, data: { turn: 1 } },
  ]

  it('travels with its content emptied', () => {
    // The head holds the surface's first position; the prompt text belongs to
    // the sender's machine, not the reader's. A copy without a head imports,
    // then fails its *next* turn, when the prompt it renders has to append one.
    const carried = selectEvents(opening()).find((event) => event.type === 'system/message')

    const message = (carried?.data as { message?: { content?: unknown, id?: unknown } } | undefined)?.message
    expect(carried?.surfaceOp).toBe('append')
    expect(message?.content).toEqual([])
    // The envelope stays: the format validates the id and reads the role.
    expect(message?.id).toBe('head-2')
  })

  it('travels only the first head, never a later replacement of it', () => {
    const selected = selectEvents([
      ...opening(),
      { ...head(6, 'second rendering', { op: 'replace', startSeq: 2, endSeq: 2 }), time: 1 },
    ])

    // A replacement re-baselines the head, and the copy has nothing to
    // re-baseline: the head it shadowed is gone, so its range points nowhere.
    expect(selected.filter((event) => event.type === 'system/message')).toHaveLength(1)
    expect(selected.findIndex((event) => event.type === 'system/message')).toBe(2)
  })

  it('travels an empty head when the source has surface nodes and none', () => {
    // A session whose head was compacted away still needs one: the reader's
    // next turn renders a prompt and appends it, which the format refuses when
    // a surface node already sits at position 0.
    const selected = selectEvents(opening().filter((event) => event.type !== 'system/message'))

    const found = selected.find((event) => event.type === 'system/message')
    expect(selected[2]?.type).toBe('system/message')
    expect(selected[0]?.type).toBe('turn/start')
    expect(selected[1]?.type).toBe('step/start')
    // Coordinates from the step it opens in, which is what the format checks.
    expect(found?.data).toMatchObject({ turn: 1, step: 1 })
    expect((found?.data as { message?: { content?: unknown } } | undefined)?.message?.content).toEqual([])
  })

  it('leaves a session with no surface nodes alone', () => {
    // Nothing to protect: the reader's first turn appends the first head, and
    // a node this module invented would have to be replaced by that prompt.
    const selected = selectEvents([
      { type: 'turn/start', seq: 0, time: 1, data: { turn: 1 } },
      { type: 'session/title', seq: 1, time: 1, data: { title: 'Renamed', messageSeqs: [], source: { kind: 'user' } } },
    ])

    expect(selected.map((event) => event.type)).toEqual(['turn/start', 'session/title'])
  })
})

describe('a compaction checkpoint', () => {
  it('travels as an append, because its compaction did not', () => {
    // `compact-checkpoint` is a user/message whose surfaceOp replaces the span
    // its summary condensed. The summary is local state and does not travel, so
    // the range has no meaning here — and the format additionally requires the
    // checkpoint's owning compaction/start, which is local state too.
    const selected = selectEvents([
      { type: 'compaction/start', seq: 0, time: 1, data: {} },
      { type: 'compaction/summary', seq: 1, time: 1, data: {} },
      { type: 'user/message', seq: 2, time: 1, data: { source: { kind: 'compact-checkpoint' } }, surfaceOp: { op: 'replace', startSeq: 0, endSeq: 1 }, sourceEventSeqs: [0, 1] },
    ])

    expect(selected.map((event) => event.type)).toEqual(['user/message'])
    expect(selected[0]?.surfaceOp).toBe('append')
    expect(selected[0]?.sourceEventSeqs).toBeUndefined()
  })

  it('leaves an ordinary message replacement alone', () => {
    // The forced append is for checkpoints only: any other replace keeps its
    // range when the range survives, and degrades to append otherwise.
    const selected = selectEvents([
      { type: 'user/message', seq: 0, time: 1, data: { source: { kind: 'user' } }, surfaceOp: 'append' },
      { type: 'user/message', seq: 1, time: 1, data: { source: { kind: 'user' } }, surfaceOp: { op: 'replace', startSeq: 0, endSeq: 0 }, sourceEventSeqs: [0] },
    ])

    expect(selected[1]?.surfaceOp).toEqual({ op: 'replace', startSeq: 0, endSeq: 0 })
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