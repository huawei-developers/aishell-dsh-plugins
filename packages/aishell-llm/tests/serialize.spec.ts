import { describe, it, expect } from 'vitest'
import type { ContentBlock, GenerateOptions, ToolCallId } from '@deepseek-ai/dsh-llm'
import type { ImageAttachmentRef, RequestImageAttachment } from '@deepseek-ai/dsh-attachment'
import { serializeRequest } from '../src/serialize.ts'
import type { RequestImages } from '../src/images.ts'
import type { WireContentPart } from '../src/types.ts'

// ── fixtures ──

const text = (t: string): ContentBlock => ({ type: 'text', text: t })

/** A durable image reference. Real ids matter: serialization keys versions by them. */
function imageRef(id = 'sha256:aaaabbbbccccdddd', width = 8, height = 8): ImageAttachmentRef {
  return {
    attachmentId: id,
    mediaType: 'image/png',
    bytes: 68,
    width,
    height,
  } as ImageAttachmentRef
}

const image = (ref = imageRef()): ContentBlock => ({ type: 'image', attachment: ref })

/**
 * One prepared request version. `data` is the PNG signature plus padding so the
 * base64 assertion below is a fixed string rather than a re-derivation.
 */
function version(
  ref: ImageAttachmentRef,
  data = Uint8Array.from([0x89, 0x50, 0x4e, 0x47]),
  // The request version may be re-encoded: different media type, different
  // dimensions. Defaults match the ref so most tests stay readable, but a test
  // that cares can make them differ — which is the only way to catch the
  // serializer reading the source reference instead of the version.
  overrides: Partial<Pick<RequestImageAttachment, 'mediaType' | 'width' | 'height'>> = {},
): RequestImageAttachment {
  return {
    variantId: 'variant-1',
    attachment: ref,
    data,
    mediaType: 'image/png',
    bytes: data.byteLength,
    width: ref.width,
    height: ref.height,
    depth: 'uchar',
    space: 'srgb',
    hasAlpha: false,
    ...overrides,
  } as unknown as RequestImageAttachment
}

/** Prepared versions for every reference passed, keyed by attachment id. */
function imagesFor(...refs: ImageAttachmentRef[]): RequestImages {
  return new Map(refs.map(ref => [ref.attachmentId, version(ref)]))
}

/** One tool-role message answering a tool call; the 0.1.7 message model. */
const toolResult = (callId: string, content: string | ContentBlock[]) => ({
  role: 'tool',
  toolCallId: callId as ToolCallId,
  content: typeof content === 'string' ? [text(content)] : content,
})

const toolCall = (id: string, name: string, args: string): ContentBlock =>
  ({ type: 'tool-call', id: id as ToolCallId, name, arguments: args }) as ContentBlock

/** Build GenerateOptions from role/content pairs. serialize only reads role + content at runtime. */
function opts(
  messages: Array<{ role: 'user' | 'system' | 'assistant' | 'developer'; content: ContentBlock[] }
    | ReturnType<typeof toolResult>>,
  extra?: Record<string, unknown>,
): GenerateOptions {
  return { provider: 'aishell', model: 'glm-5.2', messages, ...extra } as unknown as GenerateOptions
}

// ── user messages ──

describe('serializeRequest — user messages', () => {
  it('serializes plain text', () => {
    const req = serializeRequest(opts([{ role: 'user', content: [text('hello')] }]))
    expect(req.messages).toEqual([{ role: 'user', content: 'hello' }])
  })

  it('concatenates multiple text blocks', () => {
    const req = serializeRequest(opts([{ role: 'user', content: [text('hello '), text('world')] }]))
    expect(req.messages).toEqual([{ role: 'user', content: 'hello world' }])
  })

  it('emits empty content when user message has no blocks', () => {
    const req = serializeRequest(opts([{ role: 'user', content: [] }]))
    expect(req.messages).toEqual([{ role: 'user', content: '' }])
  })
})

// ── system slot ──

describe('serializeRequest — system slot', () => {
  it('prepends the one-shot system prompt ahead of the history', () => {
    // GenerateOptions.system is the one-shot caller's system slot, and its
    // contract says adapters map it ahead of `messages`. Dropping it is silent
    // — the caller gets a model with no instructions and no error.
    const req = serializeRequest(opts([{ role: 'user', content: [text('hi')] }], { system: 'be terse' }))
    expect(req.messages).toEqual([
      { role: 'system', content: 'be terse' },
      { role: 'user', content: 'hi' },
    ])
  })

  it('adds no system message when the caller supplied none', () => {
    const req = serializeRequest(opts([{ role: 'user', content: [text('hi')] }]))
    expect(req.messages).toEqual([{ role: 'user', content: 'hi' }])
  })
})

// ── images ──

describe('serializeRequest — images', () => {
  it('emits a handle-text part then the image as a base64 data URL', () => {
    const ref = imageRef()
    const req = serializeRequest(
      opts([{ role: 'user', content: [text('what is this?'), image(ref)] }]),
      imagesFor(ref),
    )
    const content = req.messages[0]!.content
    expect(Array.isArray(content)).toBe(true)
    const parts = content as WireContentPart[]
    expect(parts[0]).toEqual({ type: 'text', text: 'what is this?' })
    // The handle names the image and its projected dimensions, so a model that
    // cannot use the bytes can still refer to the occurrence.
    expect(parts[1]).toMatchObject({ type: 'text' })
    expect((parts[1] as { text: string }).text).toMatch(/request preview 8x8px/)
    expect(parts[2]).toEqual({
      type: 'image_url',
      image_url: { url: 'data:image/png;base64,iVBORw==' },
    })
  })

  it('keeps an image-only message as a parts list rather than empty text', () => {
    // An image-only user message must not serialize to `''`: the model would see
    // a blank turn with no indication an image was attached.
    const ref = imageRef()
    const req = serializeRequest(opts([{ role: 'user', content: [image(ref)] }]), imagesFor(ref))
    const parts = req.messages[0]!.content as WireContentPart[]
    expect(parts.some(p => p.type === 'image_url')).toBe(true)
    expect(req.messages[0]!.content).not.toBe('')
  })

  it('throws rather than silently dropping an unprepared image', () => {
    const ref = imageRef()
    const req = () => serializeRequest(opts([{ role: 'user', content: [image(ref)] }]), new Map())
    expect(req).toThrow(/was not prepared/)
  })

  it('throws when the history carries an image but no versions were passed at all', () => {
    const req = () => serializeRequest(opts([{ role: 'user', content: [image(imageRef())] }]))
    expect(req).toThrow(/were not prepared/)
  })
})

// ── tool-result messages ──

describe('serializeRequest — tool-result messages', () => {
  it('converts a tool-role message into a wire tool message', () => {
    const req = serializeRequest(opts([toolResult('call-1', 'sunny')]))
    expect(req.messages).toEqual([{ role: 'tool', tool_call_id: 'call-1', content: 'sunny' }])
  })

  it('keeps user text and the following tool result as separate wire messages', () => {
    const req = serializeRequest(opts([
      { role: 'user', content: [text('here: ')] },
      toolResult('call-1', 'sunny'),
    ]))
    expect(req.messages).toEqual([
      { role: 'user', content: 'here: ' },
      { role: 'tool', tool_call_id: 'call-1', content: 'sunny' },
    ])
  })
})

// ── developer messages ──

describe('serializeRequest — developer messages', () => {
  it('maps developer text onto a system-role message', () => {
    const req = serializeRequest(opts([{ role: 'developer', content: [text('use metric units')] }]))
    expect(req.messages).toEqual([{ role: 'system', content: 'use metric units' }])
  })

  it('emits no wire message for tool-change blocks without text', () => {
    const req = serializeRequest(opts([
      { role: 'developer', content: [{ type: 'tool-addition', toolName: 'search' }] as ContentBlock[] },
    ]))
    expect(req.messages).toEqual([])
  })
})

// ── system messages ──

describe('serializeRequest — system messages', () => {
  it('serializes system text', () => {
    const req = serializeRequest(opts([{ role: 'system', content: [text('be brief')] }]))
    expect(req.messages).toEqual([{ role: 'system', content: 'be brief' }])
  })
})

// ── assistant messages ──

describe('serializeRequest — assistant messages', () => {
  it('serializes plain text', () => {
    const req = serializeRequest(opts([{ role: 'assistant', content: [text('sure')] }]))
    expect(req.messages).toEqual([{ role: 'assistant', content: 'sure' }])
  })

  it('serializes tool calls with null text content', () => {
    const req = serializeRequest(opts([
      { role: 'assistant', content: [toolCall('call-1', 'get_weather', '{"city":"SF"}')] },
    ]))
    expect(req.messages).toEqual([{
      role: 'assistant',
      content: null,
      tool_calls: [{ id: 'call-1', type: 'function', function: { name: 'get_weather', arguments: '{"city":"SF"}' } }],
    }])
  })

  it('serializes text + tool calls together', () => {
    const req = serializeRequest(opts([
      { role: 'assistant', content: [text('let me check'), toolCall('call-1', 'search', '{}')] },
    ]))
    expect(req.messages).toEqual([{
      role: 'assistant',
      content: 'let me check',
      tool_calls: [{ id: 'call-1', type: 'function', function: { name: 'search', arguments: '{}' } }],
    }])
  })
})

// ── request envelope ──

describe('serializeRequest — envelope', () => {
  it('always sets stream + stream_options', () => {
    const req = serializeRequest(opts([{ role: 'user', content: [text('hi')] }]))
    expect(req.stream).toBe(true)
    expect(req.stream_options).toEqual({ include_usage: true })
  })

  it('includes tools when provided', () => {
    const req = serializeRequest(opts(
      [{ role: 'user', content: [text('hi')] }],
      { tools: [{ name: 'search', description: 'search the web', parameters: { type: 'object' } }] },
    ))
    expect(req.tools).toEqual([{
      type: 'function',
      function: { name: 'search', description: 'search the web', parameters: { type: 'object' } },
    }])
  })

  it('omits tools when empty', () => {
    const req = serializeRequest(opts([{ role: 'user', content: [text('hi')] }], { tools: [] }))
    expect(req.tools).toBeUndefined()
  })

  it('passes through optional parameters', () => {
    const req = serializeRequest(opts(
      [{ role: 'user', content: [text('hi')] }],
      { temperature: 0.7, maxTokens: 4096, stop: ['END'] },
    ))
    expect(req.temperature).toBe(0.7)
    expect(req.max_tokens).toBe(4096)
    expect(req.stop).toEqual(['END'])
  })
})

describe('serializeRequest — tool results carrying images', () => {
  it('hoists the image into a user turn and keeps the tool message textual', () => {
    const ref = imageRef('sha256:cccccccccccccccc')
    const req = serializeRequest(
      opts([toolResult('call-1', [text('here it is'), image(ref)])]),
      imagesFor(ref),
    )
    expect(req.messages[0]).toMatchObject({ role: 'tool', tool_call_id: 'call-1', content: 'here it is' })
    const parts = req.messages[1]!.content as WireContentPart[]
    expect(req.messages[1]!.role).toBe('user')
    expect(parts[0]).toEqual({ type: 'text', text: 'Attached image(s) from tool result:' })
    expect(parts.some(p => p.type === 'image_url')).toBe(true)
  })

  it('names the situation when the result was image-only', () => {
    // An empty tool content is rejected outright by some OpenAI-compatible
    // servers, and reads to the model as a blank result elsewhere.
    const ref = imageRef('sha256:dddddddddddddddd')
    const req = serializeRequest(opts([toolResult('call-1', [image(ref)])]), imagesFor(ref))
    expect(req.messages[0]).toMatchObject({ role: 'tool', content: '(see attached image)' })
  })

  it('leaves a text-only tool result untouched', () => {
    const req = serializeRequest(opts([toolResult('call-1', 'sunny')]))
    expect(req.messages).toEqual([{ role: 'tool', tool_call_id: 'call-1', content: 'sunny' }])
  })
})

describe('serializeRequest — parallel tool calls in one turn', () => {
  it('hoists a mid-run tool image after the whole run, keeping tool messages adjacent', () => {
    // The bug this guards: hoisting per message inserted the user turn between
    // two results of the same assistant turn, so the later `tool` message no
    // longer directly followed the assistant turn that requested it. The loop
    // issues parallel calls, so this is an ordinary shape.
    const ref = imageRef('sha256:eeeeeeeeeeeeeeee')
    const req = serializeRequest(opts([
      {
        role: 'assistant',
        content: [toolCall('c1', 'screenshot', '{}'), toolCall('c2', 'read_file', '{}')],
      },
      toolResult('c1', [image(ref)]),
      toolResult('c2', 'file body'),
    ]), imagesFor(ref))
    expect(req.messages.map(m => m.role)).toEqual(['assistant', 'tool', 'tool', 'user'])
    expect(req.messages[1]).toMatchObject({ tool_call_id: 'c1' })
    expect(req.messages[2]).toMatchObject({ tool_call_id: 'c2', content: 'file body' })
  })

  it('emits one hoisted turn carrying the images of every result in the run', () => {
    const a = imageRef('sha256:ffffffffffffffff')
    const b = imageRef('sha256:1111111111111111')
    const req = serializeRequest(opts([
      toolResult('c1', [text('first'), image(a)]),
      toolResult('c2', [text('second'), image(b)]),
    ]), imagesFor(a, b))
    expect(req.messages.map(m => m.role)).toEqual(['tool', 'tool', 'user'])
    const parts = req.messages[2]!.content as WireContentPart[]
    expect(parts.filter(p => p.type === 'image_url')).toHaveLength(2)
  })

  it('splits runs when a user turn separates them', () => {
    const a = imageRef('sha256:2222222222222222')
    const b = imageRef('sha256:3333333333333333')
    const req = serializeRequest(opts([
      toolResult('c1', [image(a)]),
      { role: 'user', content: [text('next')] },
      toolResult('c2', [image(b)]),
    ]), imagesFor(a, b))
    // Two independent runs, so two hoisted turns — the first immediately after
    // its own result, since the run ends there. Consecutive user messages are
    // valid on this wire.
    expect(req.messages.map(m => m.role)).toEqual(['tool', 'user', 'user', 'tool', 'user'])
    expect((req.messages[1]!.content as WireContentPart[]).some(p => p.type === 'image_url')).toBe(true)
    expect(req.messages[2]).toMatchObject({ content: 'next' })
    expect((req.messages[4]!.content as WireContentPart[]).some(p => p.type === 'image_url')).toBe(true)
  })
})

describe('serializeRequest — request versions vs source references', () => {
  it('takes the data URL media type from the request version, not the source', () => {
    // Projection may re-encode (that is what the byte target is for), so the
    // version is the only description of the bytes actually being sent.
    const ref = imageRef('sha256:4444444444444444')
    const images: RequestImages = new Map([[
      ref.attachmentId,
      version(ref, Uint8Array.from([1, 2, 3]), { mediaType: 'image/webp' }),
    ]])
    const req = serializeRequest(opts([{ role: 'user', content: [image(ref)] }]), images)
    const part = (req.messages[0]!.content as WireContentPart[]).find(p => p.type === 'image_url')
    expect(part).toEqual({ type: 'image_url', image_url: { url: 'data:image/webp;base64,AQID' } })
  })

  it('describes the projected dimensions in the handle text, not the source ones', () => {
    const ref = imageRef('sha256:5555555555555555', 4000, 2000)
    const images: RequestImages = new Map([[
      ref.attachmentId,
      version(ref, undefined, { width: 1000, height: 500 }),
    ]])
    const req = serializeRequest(opts([{ role: 'user', content: [image(ref)] }]), images)
    const parts = req.messages[0]!.content as WireContentPart[]
    expect((parts[0] as { text: string }).text).toMatch(/request preview 1000x500px/)
  })
})

describe('serializeRequest — one-shot callers', () => {
  it('carries a frozen deepFreeze-style system slot ahead of the history', () => {
    // dsh-experimental-auto-review builds exactly this: a deep-frozen options
    // object with `system` set and no system-role message. Before this adapter
    // read `system`, that policy text was dropped and the reviewer ran with no
    // instructions at all — silently.
    const frozen = Object.freeze({
      provider: 'aishell',
      model: 'glm-5.3-flash',
      system: 'REVIEW POLICY',
      temperature: 0,
      messages: Object.freeze([{ role: 'user', content: [text('review this')] }]),
    }) as unknown as GenerateOptions
    const req = serializeRequest(frozen)
    expect(req.messages).toEqual([
      { role: 'system', content: 'REVIEW POLICY' },
      { role: 'user', content: 'review this' },
    ])
  })

  it('does not mutate the options it was handed', () => {
    const messages: Array<{ role: 'user'; content: ContentBlock[] }> = [{ role: 'user', content: [text('hi')] }]
    const options = opts(messages, { system: 'be terse' })
    serializeRequest(options)
    expect(messages).toEqual([{ role: 'user', content: [text('hi')] }])
    expect(options.messages).toBe(messages)
  })
})
