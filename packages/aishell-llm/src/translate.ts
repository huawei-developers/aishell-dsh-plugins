/**
 * Translate OpenAI-compatible SSE payloads into harness {@link StreamChunk}s.
 *
 * One stateful block per content, reasoning, or tool-call index. Finish reason
 * and usage are deferred until `[DONE]`, which covers both shapes a
 * compatible endpoint produces: usage attached to the finish chunk, and usage
 * in a trailing chunk of its own.
 *
 * A stream that settles without producing any block is a failure rather than
 * an empty turn — see the note on the check before the blocks close.
 *
 * @module @huaweidevtools/aishell-dsh-llm/translate
 */

import { brandString } from '@deepseek-ai/dsh-brand'
import { LlmError } from '@deepseek-ai/dsh-llm'
import type { FinishReason, StreamChunk, TokenUsage, ToolCallId, ContentBlock } from '@deepseek-ai/dsh-llm'
import { DONE } from './sse.ts'
import type { WireChunk } from './types.ts'

/** One open block under assembly. */
interface OpenBlock {
  index: number
  kind: 'text' | 'reasoning' | 'tool-call'
  text: string
  callId: string | undefined
  name: string | undefined
}

/** Map the wire finish_reason vocabulary to the harness FinishReason. */
function mapFinishReason(reason: string | null | undefined): FinishReason {
  switch (reason) {
    case 'stop': return { kind: 'stop' }
    case 'tool_calls': return { kind: 'tool-calls' }
    case 'length': return { kind: 'max-tokens' }
    default:
      return { kind: 'error', failure: { message: `model stopped: ${reason ?? 'unknown'}`, code: (reason ?? 'unknown').toUpperCase() } }
  }
}

/** Map wire usage fields to disjoint harness counts. */
function mapUsage(usage: NonNullable<WireChunk['usage']>): TokenUsage {
  const cacheRead = usage.prompt_tokens_details?.cached_tokens
  const reasoning = usage.completion_tokens_details?.reasoning_tokens
  const combined = usage.prompt_tokens + usage.completion_tokens
  const hasExactTotal = Number.isSafeInteger(usage.prompt_tokens)
    && usage.prompt_tokens >= 0
    && Number.isSafeInteger(usage.completion_tokens)
    && usage.completion_tokens >= 0
    && Number.isSafeInteger(combined)
    && (usage.total_tokens === undefined || usage.total_tokens === combined)
  return {
    inputTokens: usage.prompt_tokens - (cacheRead ?? 0),
    outputTokens: usage.completion_tokens,
    ...(hasExactTotal ? { totalTokens: combined } : {}),
    ...(cacheRead !== undefined ? { cacheReadTokens: cacheRead } : {}),
    ...(reasoning !== undefined ? { reasoningTokens: reasoning } : {}),
  }
}

/** Assemble the final ContentBlock for one open block. */
function closeBlock(block: OpenBlock): ContentBlock {
  switch (block.kind) {
    case 'text': return { type: 'text', text: block.text }
    case 'reasoning': return { type: 'reasoning', text: block.text }
    case 'tool-call': return {
      type: 'tool-call',
      id: brandString<ToolCallId>(block.callId ?? ''),
      name: block.name ?? '',
      arguments: block.text,
    }
  }
}

/** Accept one streamed identity field for a tool call. */
function acceptIdentity(current: string | undefined, incoming: unknown): string | undefined {
  return typeof incoming === 'string' && incoming.length > 0 ? incoming : current
}

/**
 * Consume SSE data payloads (ending with `[DONE]`) and yield StreamChunks.
 */
export async function* translate(payloads: AsyncIterable<string>): AsyncGenerator<StreamChunk> {
  let nextIndex = 0
  let textBlock: OpenBlock | undefined
  let reasoningBlock: OpenBlock | undefined
  const toolBlocks = new Map<number, OpenBlock>()
  let pendingFinish: FinishReason | undefined
  let pendingUsage: TokenUsage | undefined

  function open(kind: OpenBlock['kind']): OpenBlock {
    const block: OpenBlock = { index: nextIndex, kind, text: '', callId: undefined, name: undefined }
    nextIndex++
    return block
  }

  for await (const payload of payloads) {
    if (payload === DONE) {
      break
    }

    let chunk: WireChunk
    try {
      chunk = JSON.parse(payload) as WireChunk
    } catch {
      continue // skip malformed
    }

    if (chunk.usage) {
      pendingUsage = mapUsage(chunk.usage)
    }

    const choice = chunk.choices?.[0]
    if (!choice) continue

    const delta = choice.delta
    if (delta) {
      // Text content
      if (delta.content && delta.content.length > 0) {
        if (textBlock === undefined) {
          textBlock = open('text')
          yield { type: 'block-start', index: textBlock.index, blockType: 'text' }
        }
        textBlock.text += delta.content
        yield { type: 'text-delta', index: textBlock.index, text: delta.content }
      }

      // Reasoning content
      if (delta.reasoning_content && delta.reasoning_content.length > 0) {
        if (reasoningBlock === undefined) {
          reasoningBlock = open('reasoning')
          yield { type: 'block-start', index: reasoningBlock.index, blockType: 'reasoning' }
        }
        reasoningBlock.text += delta.reasoning_content
        yield { type: 'reasoning-delta', index: reasoningBlock.index, text: delta.reasoning_content }
      }

      // Tool calls
      if (delta.tool_calls) {
        for (const tc of delta.tool_calls) {
          let block = toolBlocks.get(tc.index)
          if (block === undefined) {
            block = open('tool-call')
            toolBlocks.set(tc.index, block)
            block.callId = acceptIdentity(undefined, tc.id)
            block.name = acceptIdentity(undefined, tc.function?.name)
            yield { type: 'block-start', index: block.index, blockType: 'tool-call' }
          } else {
            block.callId = acceptIdentity(block.callId, tc.id)
            block.name = acceptIdentity(block.name, tc.function?.name)
          }
          const args = tc.function?.arguments
          if (args) {
            block.text += args
            yield {
              type: 'tool-call-delta',
              index: block.index,
              id: brandString<ToolCallId>(block.callId ?? ''),
              ...(block.name ? { name: block.name } : {}),
              argumentsDelta: args,
            }
          }
        }
      }
    }

    if (choice.finish_reason) {
      pendingFinish = mapFinishReason(choice.finish_reason)
    }
  }

  // Close all open blocks in index order (tool-call deltas may arrive
  // out of wire-index order, so sort by the assigned harness index).
  const allBlocks = [
    ...(textBlock !== undefined ? [textBlock] : []),
    ...(reasoningBlock !== undefined ? [reasoningBlock] : []),
    ...toolBlocks.values(),
  ].sort((a, b) => a.index - b.index)

  // A stream that settled cleanly but produced no block is not a model
  // choosing silence — it is the gateway answering with nothing, which happens
  // when it drops the upstream connection mid-turn or a proxy replaces the
  // body. Reporting it as `finish: stop` hands the caller an empty turn it has
  // no reason to question; naming it is what lets the retry path see it.
  //
  // Scoped to a clean finish: a `max-tokens` or error reason with no content
  // is already diagnosed by that reason, and overriding it here would replace
  // a specific failure with a vaguer one.
  if (allBlocks.length === 0 && (pendingFinish === undefined || pendingFinish.kind === 'stop')) {
    throw new LlmError('aishell-llm: gateway returned a stream with no content', 'EMPTY_RESPONSE')
  }

  for (const block of allBlocks) {
    yield { type: 'block-end', index: block.index, block: closeBlock(block) }
  }

  // Emit usage (before finish)
  if (pendingUsage !== undefined) {
    yield { type: 'usage', usage: pendingUsage }
  }

  // Emit finish
  yield {
    type: 'finish',
    reason: pendingFinish ?? { kind: 'stop' },
  }
}
