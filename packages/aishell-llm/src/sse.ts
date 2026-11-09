/**
 * SSE byte-stream parser for OpenAI-compatible chat-completions.
 *
 * Yields each event's `data` payload; the literal `[DONE]` is yielded as the
 * final value so the caller owns final flushing. EOF before `[DONE]` raises
 * `LlmError('STREAM_CLOSED')`.
 *
 * @module @huaweidevtools/aishell-dsh-llm/sse
 */

import { EventSourceParserStream } from 'eventsource-parser/stream'
import { LlmError } from '@deepseek-ai/dsh-llm'

export const DONE = '[DONE]'

export async function* parseSse(
  stream: ReadableStream<Uint8Array>,
): AsyncGenerator<string> {
  // `new TextDecoderStream()` types its writable as WritableStream<BufferSource>
  // in both the DOM and Node declarations, while pipeThrough's parameter wants
  // the exact element type — an invariance clash that no lib combination
  // satisfies. The runtime accepts any BufferSource chunk; the assertion keeps
  // the public signature precise (callers pass byte streams) while telling the
  // compiler what the pipe actually carries.
  const decoder = new TextDecoderStream() as unknown as TransformStream<Uint8Array, string>
  const events = stream
    .pipeThrough(decoder)
    .pipeThrough(new EventSourceParserStream())
  for await (const { data } of events) {
    yield data
    if (data === DONE) return
  }
  throw new LlmError('SSE stream ended without [DONE]', 'STREAM_CLOSED')
}
