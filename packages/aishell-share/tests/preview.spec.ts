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
 */

import { describe, expect, it } from 'vitest'

import { previewLines } from '../src/client/preview.ts'
import type { ShareEvent, SharePackage } from '../src/package.ts'

/** A package carrying the given events. */
function pkg(...events: ShareEvent[]): SharePackage {
  return { version: '0.0.21', title: 'Conversation', createdAt: 1, events }
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
function assistantSaid(text: string): ShareEvent {
  return {
    type: 'assistant/message',
    data: {
      turn: 1,
      step: 1,
      message: {
        role: 'assistant',
        content: [{ type: 'text', text }],
        source: { kind: 'model' },
        id: 'a',
      },
    },
    surfaceOp: 'append',
  }
}

describe('previewLines', () => {
  it('shows user and assistant text in order', () => {
    expect(previewLines(pkg(userSaid('hello'), assistantSaid('hi'))))
      .toEqual([
        { at: 0, role: 'user', text: 'hello' },
        { at: 1, role: 'assistant', text: 'hi' },
      ])
  })

  it('reads the assistant reply out of the message envelope', () => {
    // The regression this pins: the reply's text lives under `message.content`,
    // and reading the top level yields nothing — an assistant turn that
    // vanishes from the preview without anything failing.
    expect(previewLines(pkg(assistantSaid('the reply')))).toEqual([
      { at: 0, role: 'assistant', text: 'the reply' },
    ])
  })

  it('shows a tool call with the arguments it was given', () => {
    // A bare name is the least informative half of a call. A reader judging a
    // conversation needs to see what the tool was asked to do.
    const lines = previewLines(pkg({
      type: 'tool/call',
      data: {
        turn: 1,
        step: 1,
        callId: 'call_01',
        name: 'query_resources',
        arguments: '{"region":"cn-north-4"}',
      },
    }))
    expect(lines).toEqual([
      { at: 0, role: 'tool-call', text: 'query_resources({"region":"cn-north-4"})' },
    ])
  })

  it('names a tool call that carried no arguments', () => {
    const lines = previewLines(pkg({ type: 'tool/call', data: { name: 'list' } }))
    expect(lines).toEqual([{ at: 0, role: 'tool-call', text: 'list' }])
  })

  it('shows what a tool returned', () => {
    // The result answers the call before it, and it is the half a reader can
    // judge the outcome by.
    const lines = previewLines(pkg({
      type: 'tool/result',
      data: {
        turn: 1,
        step: 1,
        message: {
          role: 'tool',
          content: [{ type: 'text', text: '{"vpcIds":["vpc-1"]}' }],
          isError: false,
        },
      },
      surfaceOp: 'append',
    }))
    expect(lines).toEqual([{ at: 0, role: 'tool-result', text: '{"vpcIds":["vpc-1"]}' }])
  })

  it('marks a tool result the tool reported as a failure', () => {
    const lines = previewLines(pkg({
      type: 'tool/result',
      data: {
        message: { role: 'tool', content: [{ type: 'text', text: '502: unavailable' }], isError: true },
      },
    }))
    expect(lines).toEqual([{ at: 0, role: 'tool-result', text: '502: unavailable', isError: true }])
  })

  it('drops a tool result with no readable content', () => {
    // A tool that returned only an image or an empty body has nothing for this
    // preview to draw, and an empty chip would look like a broken answer.
    expect(previewLines(pkg({ type: 'tool/result', data: { message: { content: [] } } }))).toEqual([])
  })

  it('does not show the model reasoning that preceded its reply', () => {
    // Reasoning is the model thinking aloud. A reader deciding whether to
    // import is reading what was said, and half-formed notes shown as the
    // answer misrepresents the conversation.
    const event: ShareEvent = {
      type: 'assistant/message',
      data: {
        message: {
          role: 'assistant',
          content: [
            { type: 'reasoning', text: 'the user probably means…' },
            { type: 'text', text: 'the answer' },
          ],
        },
      },
    }
    expect(previewLines(pkg(event))).toEqual([{ at: 0, role: 'assistant', text: 'the answer' }])
  })

  it('joins several text blocks in one message', () => {
    const event: ShareEvent = {
      type: 'assistant/message',
      data: {
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'one ' }, { type: 'image' }, { type: 'text', text: 'two' }],
        },
      },
    }
    expect(previewLines(pkg(event))).toEqual([{ at: 0, role: 'assistant', text: 'one two' }])
  })

  it('drops a message with no text, which shows nothing', () => {
    const event: ShareEvent = {
      type: 'assistant/message',
      data: { message: { role: 'assistant', content: [{ type: 'image' }] } },
    }
    expect(previewLines(pkg(event))).toEqual([])
  })

  it('ignores boundary events, which are not conversation', () => {
    const lines = previewLines(pkg(
      { type: 'turn/start', data: { turn: 0 } },
      userSaid('x'),
      { type: 'turn/end', data: { turn: 0 } },
    ))
    expect(lines).toEqual([{ at: 1, role: 'user', text: 'x' }])
  })

  it('hides the runtime context and other application-written user messages', () => {
    // A real session log interleaves these with the human's turns; showing
    // them would put harness boilerplate under the sender's name.
    const lines = previewLines(pkg(
      userSaid('what the person typed'),
      {
        type: 'user/message',
        data: {
          id: 'c', role: 'user',
          content: [{ type: 'text', text: 'Current runtime context. This snapshot…' }],
          source: { kind: 'runtime-context', form: 'snapshot', sections: [] },
        },
        surfaceOp: 'append',
      },
      {
        type: 'user/message',
        data: {
          id: 't', role: 'user',
          content: [{ type: 'text', text: 'Time sampled while preparing turn 1' }],
          source: { kind: 'time-context', form: 'snapshot' },
        },
        surfaceOp: 'append',
      },
    ))

    expect(lines).toEqual([{ at: 0, role: 'user', text: 'what the person typed' }])
  })

  it('survives a message whose data is not what it expects', () => {
    expect(() => previewLines(pkg({ type: 'user/message', data: null }))).not.toThrow()
    expect(previewLines(pkg({ type: 'user/message', data: null }))).toEqual([])
    expect(() => previewLines(pkg({ type: 'tool/call', data: 'text' }))).not.toThrow()
    expect(() => previewLines(pkg({ type: 'tool/result', data: null }))).not.toThrow()
    expect(() => previewLines(pkg({ type: 'assistant/message', data: null }))).not.toThrow()
  })
})