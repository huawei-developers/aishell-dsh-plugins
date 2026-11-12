/**
 * Turning a package into what a reader sees.
 *
 * The preview is the only place a person judges whether to import, so what it
 * drops and what it keeps is a decision worth pinning: an event type shown raw
 * would tell them nothing, and a missing message would hide what they are
 * about to accept.
 */

import { describe, expect, it } from 'vitest'

import { previewLines } from '../src/client/preview.ts'
import type { ShareEvent, SharePackage } from '../src/package.ts'

/** A package carrying the given events. */
function pkg(...events: ShareEvent[]): SharePackage {
  return { version: '0.0.21', title: 'Conversation', createdAt: 1, events }
}

/** One message event with the given text. */
function message(type: 'user/message' | 'assistant/message', text: string): ShareEvent {
  return {
    type,
    data: { id: 'm', role: type === 'user/message' ? 'user' : 'assistant', content: [{ type: 'text', text }], source: { kind: 'user' } },
    surfaceOp: 'append',
  }
}

describe('previewLines', () => {
  it('shows user and assistant text in order', () => {
    expect(previewLines(pkg(message('user/message', 'hello'), message('assistant/message', 'hi'))))
      .toEqual([
        { at: 0, role: 'user', text: 'hello' },
        { at: 1, role: 'assistant', text: 'hi' },
      ])
  })

  it('folds a tool call into one line naming the tool', () => {
    const lines = previewLines(pkg({ type: 'tool/call', data: { name: 'query_resources', arguments: '{}' } }))
    expect(lines).toEqual([{ at: 0, role: 'tool', text: 'query_resources' }])
  })

  it('does not repeat a tool result, which the preview cannot show', () => {
    const lines = previewLines(pkg({ type: 'tool/result', data: { message: { id: 't', role: 'tool' } } }))
    expect(lines).toEqual([])
  })

  it('joins several text blocks in one message', () => {
    const event: ShareEvent = {
      type: 'assistant/message',
      data: {
        id: 'a', role: 'assistant',
        content: [{ type: 'text', text: 'one ' }, { type: 'image' }, { type: 'text', text: 'two' }],
        source: { kind: 'model' },
      },
    }
    expect(previewLines(pkg(event))).toEqual([{ at: 0, role: 'assistant', text: 'one two' }])
  })

  it('drops a message with no text, which shows nothing', () => {
    const event: ShareEvent = {
      type: 'assistant/message',
      data: { id: 'a', role: 'assistant', content: [{ type: 'image' }], source: { kind: 'model' } },
    }
    expect(previewLines(pkg(event))).toEqual([])
  })

  it('ignores boundary events, which are not conversation', () => {
    const lines = previewLines(pkg(
      { type: 'turn/start', data: { turn: 0 } },
      message('user/message', 'x'),
      { type: 'turn/end', data: { turn: 0 } },
    ))
    expect(lines).toEqual([{ at: 1, role: 'user', text: 'x' }])
  })

  it('hides the runtime context and other application-written user messages', () => {
    // A real session log interleaves these with the human's turns; showing
    // them would put harness boilerplate under the sender's name.
    const lines = previewLines(pkg(
      message('user/message', 'what the person typed'),
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
  })
})