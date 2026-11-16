/**
 * Turning a package into what a reader sees.
 *
 * The preview is the only place a person judges whether to import, so what it
 * drops and what it keeps is a decision worth pinning: an event type shown raw
 * would tell them nothing, and a missing message would hide what they are
 * about to accept.
 *
 * ## The fixtures mirror the log, not a convenient shape
 *
 * The two roles store their content differently — a user turn is flat, an
 * assistant or tool turn is wrapped in `message` — and a fixture that papered
 * over that difference would pass while the real preview showed an assistant
 * reply as nothing. Every literal below is copied from a decompressed session
 * log, so an assertion here is an assertion about the product.
 *
 * ## The shape this asserts
 *
 * A Turn that used tools is one folded group; one that did not is plain lines.
 * That split is the whole point of the grouping — without it the transcript is
 * a wall of tool rows with the conversation buried in it.
 */

import { describe, expect, it } from 'vitest'

import { previewItems } from '../src/client/preview.ts'
import type { ShareEvent, SharePackage } from '../src/package.ts'

/** A package carrying the given events. */
function pkg(...events: ShareEvent[]): SharePackage {
  return { version: '0.0.28', title: 'Conversation', createdAt: 1, events }
}

/** One human message event, in the flat shape the log writes it. */
function userSaid(text: string): ShareEvent {
  return {
    type: 'user/message',
    data: {
      id: 'u',
      role: 'user',
      content: [{ type: 'text', text }],
      source: { kind: 'user' },
    },
    surfaceOp: 'append',
  }
}

/** One assistant message event, in the wrapped shape the log writes it. */
function assistantSaid(
  text: string,
  blocks?: readonly Record<string, unknown>[],
  step = 1,
): ShareEvent {
  return {
    type: 'assistant/message',
    data: {
      turn: 1,
      step,
      message: {
        role: 'assistant',
        content: blocks ?? [{ type: 'text', text }],
        source: { kind: 'model' },
        id: 'a',
      },
    },
    surfaceOp: 'append',
  }
}

/** One tool invocation, in the shape the log writes it. */
function called(name: string, args: string, callId = 'call_01', step = 1): ShareEvent {
  return { type: 'tool/call', data: { turn: 1, step, callId, name, arguments: args } }
}

/** One tool answer, in the shape the log writes it. */
function returned(text: string, isError = false, callId = 'call_01', step = 1): ShareEvent {
  return {
    type: 'tool/result',
    data: {
      turn: 1,
      step,
      message: {
        role: 'tool',
        toolCallId: callId,
        content: [{ type: 'text', text }],
        isError,
      },
      surfaceOp: 'append',
    },
  }
}

describe('previewItems — the conversation', () => {
  it('shows what the person typed', () => {
    expect(previewItems(pkg(userSaid('hello')))).toEqual([{ kind: 'user', at: 0, text: 'hello' }])
  })

  it('shows an assistant reply as its own line when no tool ran', () => {
    // A Turn that answered without a tool is a reply, not work. Folding it
    // would put a disclosure over one sentence.
    expect(previewItems(pkg(assistantSaid('hi')))).toEqual([{ kind: 'assistant', at: 0, text: 'hi' }])
  })

  it('reads the assistant reply out of the message envelope', () => {
    // The regression this pins: the reply's text lives under `message.content`,
    // and reading the top level yields nothing — an assistant turn that
    // vanishes from the preview without anything failing.
    expect(previewItems(pkg(assistantSaid('the reply')))).toEqual([
      { kind: 'assistant', at: 0, text: 'the reply' },
    ])
  })

  it('does not show the model reasoning that preceded its reply', () => {
    // Reasoning is the model thinking aloud. A reader deciding whether to
    // import is reading what was said, and half-formed notes shown as the
    // answer misrepresents the conversation.
    const event = assistantSaid('', [
      { type: 'reasoning', text: 'the user probably means…' },
      { type: 'text', text: 'the answer' },
    ])
    expect(previewItems(pkg(event))).toEqual([{ kind: 'assistant', at: 0, text: 'the answer' }])
  })

  it('drops a message with no text, which shows nothing', () => {
    expect(previewItems(pkg(assistantSaid('', [{ type: 'image' }])))).toEqual([])
  })

  it('hides the runtime context and other application-written user messages', () => {
    const context: ShareEvent = {
      type: 'user/message',
      data: {
        id: 'c', role: 'user',
        content: [{ type: 'text', text: 'Current runtime context. This snapshot…' }],
        source: { kind: 'runtime-context', form: 'snapshot', sections: [] },
      },
    }
    expect(previewItems(pkg(context, userSaid('what the person typed')))).toEqual([
      { kind: 'user', at: 1, text: 'what the person typed' },
    ])
  })
})

describe('previewItems — a Turn of work', () => {
  it('groups the steps of a Turn that used a tool into one fold', () => {
    // The group is what keeps a long conversation readable: shown one line
    // each, the steps bury the words a reader came to judge.
    const items = previewItems(pkg(
      userSaid('make a sandbox'),
      { type: 'turn/start', data: { turn: 1 } },
      assistantSaid('I will try.'),
      called('sandbox_create', '{"timeoutMs":180000}'),
      returned('Error: 502', true),
      { type: 'turn/end', data: { turn: 1 } },
    ))

    expect(items).toHaveLength(2)
    expect(items[0]).toEqual({ kind: 'user', at: 0, text: 'make a sandbox' })
    const turn = items[1]
    if (turn === undefined || turn.kind !== 'turn') throw new Error('expected a turn group')
    expect(turn.steps).toEqual([
      { kind: 'message', text: 'I will try.' },
      {
        kind: 'tool',
        name: 'sandbox_create',
        arguments: '{"timeoutMs":180000}',
        result: 'Error: 502',
        isError: true,
      },
    ])
  })

  it('pairs a call with the result that answers it', () => {
    // The call and its answer are two events describing one step. Split, the
    // reader sees a command and then a stray block of output.
    const items = previewItems(pkg(
      { type: 'turn/start', data: { turn: 1 } },
      called('query', '{"region":"cn-north-4"}'),
      returned('{"vpcIds":["vpc-1"]}'),
      { type: 'turn/end', data: { turn: 1 } },
    ))
    const turn = items[0]
    if (turn === undefined || turn.kind !== 'turn') throw new Error('expected a turn group')
    expect(turn.steps).toHaveLength(1)
    expect(turn.steps[0]).toEqual({
      kind: 'tool',
      name: 'query',
      arguments: '{"region":"cn-north-4"}',
      result: '{"vpcIds":["vpc-1"]}',
    })
  })

  it('keeps several steps of one Turn in the order they ran', () => {
    const items = previewItems(pkg(
      { type: 'turn/start', data: { turn: 1 } },
      called('first', '{}', 'call_01'),
      returned('one', false, 'call_01'),
      called('second', '{}', 'call_02'),
      returned('two', false, 'call_02'),
      { type: 'turn/end', data: { turn: 1 } },
    ))
    const turn = items[0]
    if (turn === undefined || turn.kind !== 'turn') throw new Error('expected a turn group')
    expect(turn.steps.map((step) => step.kind === 'tool' ? step.name : step.kind))
      .toEqual(['first', 'second'])
    expect(turn.steps.map((step) => step.kind === 'tool' ? step.result : undefined))
      .toEqual(['one', 'two'])
  })

  it('keeps a call whose result the package never carried', () => {
    // A conversation cut at a message boundary can end between the call and its
    // answer. Dropping the call would hide that the tool was ever asked to run.
    const items = previewItems(pkg(
      { type: 'turn/start', data: { turn: 1 } },
      called('sandbox_create', '{}'),
      { type: 'turn/end', data: { turn: 1 } },
    ))
    const turn = items[0]
    if (turn === undefined || turn.kind !== 'turn') throw new Error('expected a turn group')
    expect(turn.steps[0]).toEqual({ kind: 'tool', name: 'sandbox_create', arguments: '{}' })
  })

  it('does not treat the tool-call block inside a message as a second call', () => {
    // The log records one invocation twice: the `tool/call` event, and a
    // `tool-call` block inside the message that asked for it. Reading both
    // would show every call twice.
    const items = previewItems(pkg(
      { type: 'turn/start', data: { turn: 1 } },
      assistantSaid('', [
        { type: 'text', text: 'trying' },
        { type: 'tool-call', id: 'call_01', name: 'sandbox_create', arguments: '{}' },
      ]),
      called('sandbox_create', '{}'),
      returned('ok'),
      { type: 'turn/end', data: { turn: 1 } },
    ))
    const turn = items[0]
    if (turn === undefined || turn.kind !== 'turn') throw new Error('expected a turn group')
    expect(turn.steps).toHaveLength(2)
    expect(turn.steps.filter((step) => step.kind === 'tool')).toHaveLength(1)
  })

  it('keeps the conclusion of a Turn outside the fold', () => {
    // The failure this pins: a Turn ends by answering, and folding the answer
    // away leaves a card where the model asks and never concludes. Only the
    // work that produced the reply belongs in the fold.
    const items = previewItems(pkg(
      { type: 'turn/start', data: { turn: 1 } },
      assistantSaid('I will try.', undefined, 1),
      called('sandbox_create', '{}', 'call_01', 1),
      returned('502', true, 'call_01', 1),
      assistantSaid('It failed: 502 auth_unavailable.', undefined, 2),
      { type: 'turn/end', data: { turn: 1 } },
    ))
    expect(items).toHaveLength(1)
    const turn = items[0]
    if (turn === undefined || turn.kind !== 'turn') throw new Error('expected a turn group')
    expect(turn.answer).toBe('It failed: 502 auth_unavailable.')
    // The work is everything before the answering Step.
    expect(turn.steps.map((step) => step.kind === 'tool' ? step.name : step.kind))
      .toEqual(['message', 'sandbox_create'])
  })

  it('keeps every message as work when the last Step still used a tool', () => {
    // An unfinished Turn has not answered. Whatever it said along the way is
    // part of the process, and there is no conclusion to lift out.
    const items = previewItems(pkg(
      { type: 'turn/start', data: { turn: 1 } },
      assistantSaid('I will try.', undefined, 1),
      called('sandbox_create', '{}', 'call_01', 1),
      returned('502', true, 'call_01', 1),
      { type: 'turn/end', data: { turn: 1 } },
    ))
    const turn = items[0]
    if (turn === undefined || turn.kind !== 'turn') throw new Error('expected a turn group')
    expect(turn.answer).toBeUndefined()
    expect(turn.steps.map((step) => step.kind)).toEqual(['message', 'tool'])
  })

  it('gives each reply a position of its own', () => {
    // The list is keyed on `at`. Two messages in one Turn that shared the
    // Turn's start position would collide, and React would reuse one node for
    // both — the second reply disappearing from the card.
    const items = previewItems(pkg(
      { type: 'turn/start', data: { turn: 1 } },
      assistantSaid('first', undefined, 1),
      assistantSaid('second', undefined, 2),
      { type: 'turn/end', data: { turn: 1 } },
    ))
    expect(items.map((item) => item.at)).toEqual([1, 2])
    expect(new Set(items.map((item) => item.at)).size).toBe(items.length)
  })

  it('ignores boundary events, which are not conversation', () => {
    const items = previewItems(pkg(
      { type: 'turn/start', data: { turn: 0 } },
      userSaid('x'),
      { type: 'turn/end', data: { turn: 0 } },
    ))
    expect(items).toEqual([{ kind: 'user', at: 1, text: 'x' }])
  })

  it('survives data that is not what it expects', () => {
    expect(() => previewItems(pkg({ type: 'user/message', data: null }))).not.toThrow()
    expect(() => previewItems(pkg({ type: 'tool/call', data: 'text' }))).not.toThrow()
    expect(() => previewItems(pkg({ type: 'tool/result', data: null }))).not.toThrow()
    expect(() => previewItems(pkg({ type: 'assistant/message', data: null }))).not.toThrow()
    expect(previewItems(pkg({ type: 'user/message', data: null }))).toEqual([])
  })
})