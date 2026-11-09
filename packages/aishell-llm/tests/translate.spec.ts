import { describe, it, expect } from 'vitest'
import type { ContentBlock, StreamChunk } from '@deepseek-ai/dsh-llm'
import { translate } from '../src/translate.ts'

/**
 * Drain a `translate()` run into an array.
 *
 * Typed as `StreamChunk[]` rather than left to inference, which would give
 * `never[]` on an empty literal — and the element shape is what the helpers
 * below narrow from.
 */
async function collect(payloads: AsyncIterable<string>): Promise<StreamChunk[]> {
  const out: StreamChunk[] = []
  for await (const c of translate(payloads)) out.push(c)
  return out
}

/**
 * The last chunk, which for `translate` is always the terminating `finish`.
 * `noUncheckedIndexedAccess` types every index as possibly undefined, so the
 * presence check happens here once rather than at each read.
 */
function lastChunk(out: StreamChunk[]): StreamChunk {
  const last = out[out.length - 1]
  expect(last).toBeDefined()
  return last as StreamChunk
}

/**
 * `Array.prototype.find` with a type predicate, so the result is narrowed to
 * the variant that was searched for rather than to the whole union. Without
 * this, `find(c => c.type === 'finish')` still yields `StreamChunk | undefined`
 * and every property access on it is an error.
 */
function findChunk<T extends StreamChunk['type']>(
  out: StreamChunk[],
  type: T,
): Extract<StreamChunk, { type: T }> {
  const found = out.find(c => c.type === type)
  expect(found).toBeDefined()
  return found as Extract<StreamChunk, { type: T }>
}

/** The `block` of the single `block-end` chunk, narrowed to a tool call. */
function toolCallBlock(out: StreamChunk[]): Extract<ContentBlock, { type: 'tool-call' }> {
  const end = findChunk(out, 'block-end')
  expect(end.block.type).toBe('tool-call')
  return end.block as Extract<ContentBlock, { type: 'tool-call' }>
}

/** Build an async iterable of SSE data payloads (what parseSse yields). */
async function* payloads(data: string[]): AsyncGenerator<string> {
  for (const d of data) yield d
}

describe('translate — text streaming', () => {
  it('emits block-start, text-deltas, block-end, finish', async () => {
    const chunks: string[] = [
      JSON.stringify({ choices: [{ delta: { content: 'Hello' } }] }),
      JSON.stringify({ choices: [{ delta: { content: ' world' } }] }),
      JSON.stringify({ choices: [{ finish_reason: 'stop' }] }),
      '[DONE]',
    ]
    const out = await collect(payloads(chunks))

    const types = out.map(c => c.type)
    expect(types[0]).toBe('block-start')
    expect(types[1]).toBe('text-delta')
    expect(types[2]).toBe('text-delta')
    expect(types[out.length - 1]).toBe('finish')
    expect((lastChunk(out) as Extract<StreamChunk, { type: 'finish' }>).reason).toEqual({ kind: 'stop' })

    const textDelta = out.find(c => c.type === 'text-delta' && c.text === 'Hello')
    expect(textDelta).toBeDefined()
  })
})

describe('translate — reasoning streaming', () => {
  it('emits reasoning-delta for reasoning_content', async () => {
    const chunks: string[] = [
      JSON.stringify({ choices: [{ delta: { reasoning_content: 'Thinking...' } }] }),
      JSON.stringify({ choices: [{ finish_reason: 'stop' }] }),
      '[DONE]',
    ]
    const out = await collect(payloads(chunks))

    expect(out.some(c => c.type === 'reasoning-delta' && c.text === 'Thinking...')).toBe(true)
    // reasoning block must be closed before finish
    const blockEndIdx = out.findIndex(c => c.type === 'block-end')
    const finishIdx = out.findIndex(c => c.type === 'finish')
    expect(blockEndIdx).toBeLessThan(finishIdx)
  })
})

describe('translate — tool calls', () => {
  it('accumulates tool-call arguments across deltas', async () => {
    const chunks: string[] = [
      JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'get_weather', arguments: '{"ci' } }] } }] }),
      JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: 'ty":"Beijing"}' } }] } }] }),
      JSON.stringify({ choices: [{ finish_reason: 'tool_calls' }] }),
      '[DONE]',
    ]
    const out = await collect(payloads(chunks))

    const block = toolCallBlock(out)
    expect(block.name).toBe('get_weather')
    expect(block.arguments).toBe('{"city":"Beijing"}')

    expect(findChunk(out, 'finish').reason).toEqual({ kind: 'tool-calls' })
  })
})

describe('translate — usage + finish', () => {
  it('maps usage fields including reasoning tokens', async () => {
    const chunks: string[] = [
      JSON.stringify({ choices: [{ delta: { content: 'hello' } }] }),
      JSON.stringify({ choices: [{ finish_reason: 'stop' }] }),
      JSON.stringify({ usage: { prompt_tokens: 17, completion_tokens: 954, total_tokens: 971, completion_tokens_details: { reasoning_tokens: 922 } } }),
      '[DONE]',
    ]
    const out = await collect(payloads(chunks))

    const { usage } = findChunk(out, 'usage')
    expect(usage.inputTokens).toBe(17)
    expect(usage.outputTokens).toBe(954)
    expect(usage.reasoningTokens).toBe(922)
    expect(usage.totalTokens).toBe(971)

    // usage must come before finish
    const usageIdx = out.findIndex(c => c.type === 'usage')
    const finishIdx = out.findIndex(c => c.type === 'finish')
    expect(usageIdx).toBeLessThan(finishIdx)
  })
})

describe('translate — finish reasons', () => {
  it('maps length → max-tokens', async () => {
    const chunks: string[] = [
      JSON.stringify({ choices: [{ delta: { content: 'cut off' } }] }),
      JSON.stringify({ choices: [{ finish_reason: 'length' }] }),
      '[DONE]',
    ]
    const out = await collect(payloads(chunks))
    expect((lastChunk(out) as Extract<StreamChunk, { type: 'finish' }>).reason).toEqual({ kind: 'max-tokens' })
  })

  it('defaults to stop when no finish_reason', async () => {
    const chunks: string[] = [
      JSON.stringify({ choices: [{ delta: { content: 'ok' } }] }),
      '[DONE]',
    ]
    const out = await collect(payloads(chunks))
    expect((lastChunk(out) as Extract<StreamChunk, { type: 'finish' }>).reason).toEqual({ kind: 'stop' })
  })
})

describe('translate — an empty stream is a failure, not a silent turn', () => {
  // A gateway that drops the upstream connection mid-turn, or a proxy that
  // replaces the body, can settle the SSE stream cleanly with nothing in it.
  // Reporting that as `finish: stop` hands the caller an empty turn it has no
  // reason to question, and the retry path never sees a failure.
  it('fails a stream that carries only [DONE]', async () => {
    await expect(collect(payloads(['[DONE]']))).rejects.toThrow(/no content/)
  })

  it('fails a stream that carries only usage', async () => {
    // Usage alone is the shape a truncated body is most likely to leave: the
    // gateway already accounted for the tokens it did not deliver.
    const chunks = [
      JSON.stringify({ usage: { prompt_tokens: 10, completion_tokens: 0 } }),
      '[DONE]',
    ]
    await expect(collect(payloads(chunks))).rejects.toThrow(/no content/)
  })

  it('fails a stream that carries only a clean finish reason', async () => {
    const chunks = [JSON.stringify({ choices: [{ finish_reason: 'stop' }] }), '[DONE]']
    await expect(collect(payloads(chunks))).rejects.toThrow(/no content/)
  })

  it('does not override a specific finish reason', async () => {
    // A `max-tokens` or error finish already says what happened; replacing it
    // with EMPTY_RESPONSE would trade a specific diagnosis for a vaguer one.
    const chunks = [JSON.stringify({ choices: [{ finish_reason: 'length' }] }), '[DONE]']
    const out = await collect(payloads(chunks))
    expect((lastChunk(out) as Extract<StreamChunk, { type: 'finish' }>).reason).toEqual({ kind: 'max-tokens' })
  })
})

describe('translate — edge cases', () => {
  it('skips malformed JSON chunks', async () => {
    const chunks: string[] = [
      'not json',
      JSON.stringify({ choices: [{ delta: { content: 'ok' } }] }),
      JSON.stringify({ choices: [{ finish_reason: 'stop' }] }),
      '[DONE]',
    ]
    const out = await collect(payloads(chunks))
    expect(out.some(c => c.type === 'text-delta' && c.text === 'ok')).toBe(true)
  })

  it('handles interleaved text + reasoning blocks', async () => {
    const chunks: string[] = [
      JSON.stringify({ choices: [{ delta: { reasoning_content: 'think' } }] }),
      JSON.stringify({ choices: [{ delta: { content: 'answer' } }] }),
      JSON.stringify({ choices: [{ finish_reason: 'stop' }] }),
      '[DONE]',
    ]
    const out = await collect(payloads(chunks))

    // Both blocks must be opened and closed
    // `filter` with a type predicate narrows the array to that variant, so the
    // `index` reads below are checked rather than cast.
    const blockStarts = out.filter(
      (c): c is Extract<StreamChunk, { type: 'block-start' }> => c.type === 'block-start',
    )
    const blockEnds = out.filter(
      (c): c is Extract<StreamChunk, { type: 'block-end' }> => c.type === 'block-end',
    )
    expect(blockStarts).toHaveLength(2)
    expect(blockEnds).toHaveLength(2)
    // Blocks closed in index order
    expect(blockEnds[0]?.index).toBeLessThanOrEqual(blockEnds[1]?.index ?? -1)
  })
})
