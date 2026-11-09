/**
 * Serialize harness {@link GenerateOptions} into an OpenAI-compatible wire request.
 *
 * A message without an image serializes to a plain string — the shape every
 * OpenAI-compatible endpoint accepts for text. A message carrying one
 * serializes to an ordered part list instead: a handle-text part naming the
 * image, then the image itself as a base64 data URL, which is the only shape
 * those endpoints accept image input in.
 *
 * Image bytes are not read here. The harness hands over durable references,
 * not bytes, so `prepareRequestImages` resolves them one step ahead of this
 * call and passes the result in; that keeps this function synchronous and
 * keeps the one await in the adapter, where the attachment service is
 * reachable.
 *
 * @module @huaweidevtools/aishell-dsh-llm/serialize
 */

import { LlmError, requestImageHandleText } from '@deepseek-ai/dsh-llm'
import type { ContentBlock, GenerateOptions } from '@deepseek-ai/dsh-llm'
import type { RequestImageAttachment } from '@deepseek-ai/dsh-attachment'
import { requireRequestImage, type ImageAccessResolver, type RequestImages } from './images.ts'
import type {
  WireContent,
  WireContentPart,
  WireMessage,
  WireRequest,
  WireTool,
  WireAssistantToolCall,
} from './types.ts'

/**
 * Build the POST body for `/chat/completions`.
 *
 * @param options - provider-neutral request.
 * @param images - prepared request versions, required only when the history carries a retained image.
 * @param resolveAccess - execution-world path resolver for image handle text, when a provider exposes one.
 * @returns the OpenAI-compatible request body.
 */
export function serializeRequest(
  options: GenerateOptions,
  images?: RequestImages,
  resolveAccess?: ImageAccessResolver,
): WireRequest {
  const messages: WireMessage[] = []
  // `system` is the one-shot caller's system slot and belongs ahead of the
  // history, per its own contract ("adapters map it to the provider's system
  // slot ahead of `messages`"). Loop-built requests leave it undefined and
  // carry the prompt as a leading system message, so this is a no-op for the
  // ordinary conversation path.
  if (options.system !== undefined) {
    messages.push({ role: 'system', content: options.system })
  }
  // Image-bearing tool results awaiting the end of their run; see the `tool`
  // branch below for why they are not emitted per message.
  let pendingToolImages: (readonly ContentBlock[])[] = []
  for (const [index, message] of options.messages.entries()) {
    if (message.role === 'user') {
      // A user-role message carries human text and, optionally, images; tool
      // results are separate tool-role messages. A message without text still
      // occupies its turn — as an empty string, or as a parts list holding
      // only the image.
      messages.push({
        role: 'user',
        content: contentFor(message.content, images, resolveAccess) ?? blocksToText(message.content),
      })
    } else if (message.role === 'tool') {
      // One tool-role message answers one assistant tool call. Its content is
      // text only — see the note on WireToolMessage: a tool result carrying an
      // image still sends its text here (or a placeholder when it has none),
      // and the images ride a single synthetic user turn *after the whole run*
      // of tool results. Collecting them per message instead would insert that
      // user turn between two results of the same assistant turn, leaving a
      // later `tool` message detached from the assistant turn that requested
      // it — which OpenAI's ordering requires and some servers reject.
      const toolText = blocksToText(message.content)
      const hasImages = message.content.some(block => block.type === 'image')
      messages.push({
        role: 'tool',
        tool_call_id: String(message.toolCallId),
        // A result whose only content is an image would otherwise send an
        // empty string, which some OpenAI-compatible servers reject outright
        // and the rest show the model as a blank tool result. Name what
        // happened instead — the wording the ecosystem's OpenAI path uses.
        content: toolText.length > 0 || !hasImages ? toolText : TOOL_IMAGES_ONLY,
      })
      if (hasImages) pendingToolImages.push(message.content)
      if (isLastToolOfRun(options.messages, index)) {
        const hoisted = hoistedToolImages(pendingToolImages, images, resolveAccess)
        pendingToolImages = []
        if (hoisted !== undefined) messages.push({ role: 'user', content: hoisted })
      }
    } else if (message.role === 'developer') {
      // Developer messages carry tool-change blocks and optional text; the
      // `tools` field already reflects the active declaration set, so only the
      // text reaches the wire, as one system-role message.
      const text = blocksToText(message.content)
      if (text) {
        messages.push({ role: 'system', content: text })
      }
    } else if (message.role === 'system') {
      messages.push({ role: 'system', content: blocksToText(message.content) })
    } else {
      // assistant: separate tool-call blocks from text
      const toolCalls = message.content.filter(isToolCallBlock).map(serializeAssistantToolCall)
      const assistantText = blocksToText(message.content.filter(block => !isToolCallBlock(block)))
      messages.push({
        role: 'assistant',
        content: assistantText || null,
        ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
      })
    }
  }
  return {
    model: options.model,
    messages,
    stream: true,
    stream_options: { include_usage: true },
    ...(options.tools && options.tools.length > 0
      ? { tools: options.tools.map(serializeTool) }
      : {}),
    ...(options.temperature !== undefined ? { temperature: options.temperature } : {}),
    ...(options.maxTokens !== undefined ? { max_tokens: options.maxTokens } : {}),
    ...(options.stop !== undefined ? { stop: options.stop } : {}),
  }
}

/** Intro line naming what the hoisted parts are, matching the ecosystem's wording. */
const TOOL_IMAGES_INTRO = 'Attached image(s) from tool result:'

/** Stand-in for a tool result whose only content was an image, which cannot ride the tool message itself. */
const TOOL_IMAGES_ONLY = '(see attached image)'

/**
 * Whether the tool-role message at `index` is the last of its consecutive run.
 *
 * Tool results arrive as a run, one per call the assistant issued in a single
 * turn, and they must stay adjacent to that assistant turn on the wire. The
 * hoisted user turn therefore waits for the run's end rather than following
 * whichever result happened to carry the image.
 *
 * @param messages - the complete request history.
 * @param index - position of the tool-role message being serialized.
 * @returns whether no further tool-role message follows.
 */
function isLastToolOfRun(messages: readonly { role: string }[], index: number): boolean {
  return messages[index + 1]?.role !== 'tool'
}

/**
 * Parts for one tool-result run's images, hoisted into a user turn.
 *
 * An OpenAI tool message carries text only, so an image a tool returned has
 * nowhere to go in its own message; sending it as a following `user` turn is
 * how the one OpenAI-path serializer in the ecosystem handles the same
 * situation. The tool messages keep their text (or a placeholder), so the
 * model is not left with an empty result to explain away.
 *
 * @param run - content blocks of every image-bearing tool result in one run.
 * @param images - prepared request versions.
 * @param resolveAccess - execution-world path resolver, when available.
 * @returns the user-turn part list, or `undefined` when the run carried no image.
 */
function hoistedToolImages(
  run: readonly (readonly ContentBlock[])[],
  images: RequestImages | undefined,
  resolveAccess: ImageAccessResolver | undefined,
): WireContent | undefined {
  if (run.length === 0) return undefined
  if (images === undefined) {
    throw new LlmError('aishell-llm request images were not prepared', 'INVALID_REQUEST')
  }
  const parts: WireContentPart[] = [{ type: 'text', text: TOOL_IMAGES_INTRO }]
  for (const blocks of run) {
    for (const block of blocks) {
      if (block.type !== 'image') continue
      const version = requireRequestImage(images, block.attachment)
      parts.push({ type: 'text', text: requestImageHandleText(block.attachment, version, resolveAccess?.(block.attachment)) })
      parts.push({ type: 'image_url', image_url: { url: dataUrl(version) } })
    }
  }
  return parts
}

/**
 * Content for one user message: a parts list when it carries an image,
 * otherwise `undefined` so the caller falls back to plain text.
 *
 * Each image is preceded by a text part carrying its stable model-facing
 * handle, which names the image and the dimensions it was projected to — so a
 * model that cannot use the bytes can still refer to the occurrence, and one
 * that can reads what was actually sent rather than what was uploaded.
 *
 * @param blocks - content blocks of one user message.
 * @param images - prepared request versions.
 * @param resolveAccess - execution-world path resolver, when available.
 * @returns the part list, or `undefined` when the message has no image.
 */
function contentFor(
  blocks: readonly ContentBlock[],
  images: RequestImages | undefined,
  resolveAccess: ImageAccessResolver | undefined,
): WireContent | undefined {
  if (!blocks.some(block => block.type === 'image')) return undefined
  if (images === undefined) {
    throw new LlmError('aishell-llm request images were not prepared', 'INVALID_REQUEST')
  }
  const parts: WireContentPart[] = []
  for (const block of blocks) {
    if (block.type === 'image') {
      const version = requireRequestImage(images, block.attachment)
      parts.push({
        type: 'text',
        text: requestImageHandleText(block.attachment, version, resolveAccess?.(block.attachment)),
      })
      parts.push({ type: 'image_url', image_url: { url: dataUrl(version) } })
      continue
    }
    // Reasoning folds into text alongside visible text: an OpenAI-compatible
    // wire has one text channel per content block, and dropping reasoning here
    // would silently lose history the model was shown.
    if (block.type === 'text' || block.type === 'reasoning') {
      if (block.text.length > 0) parts.push({ type: 'text', text: block.text })
    }
  }
  return parts
}

/**
 * Inline data URL for one prepared image.
 *
 * Media type comes from the request *version*, not the source reference: the
 * attachment service may re-encode during projection (that is what the byte
 * target is for), so the version is the only description of the bytes actually
 * being sent.
 *
 * Encoded through `btoa` over a byte string rather than `Buffer`: this package
 * compiles host and browser halves in one project under `types: []` with the
 * DOM lib, so the Node global is neither declared nor reachable here. `btoa` is
 * a global in both Node 22+ and every browser, which is why it is the one that
 * typechecks in both halves.
 *
 * The byte string is built in chunks. One `String.fromCharCode` per byte is
 * quadratic in the string's length on engines without rope concatenation, and
 * a request image may carry a megabyte; spreading a bounded chunk into the
 * call is linear and stays under the argument-count limit.
 *
 * @param version - prepared request version.
 * @returns a base64 data URL.
 */
function dataUrl(version: RequestImageAttachment): string {
  const bytes = version.data
  const chunks: string[] = []
  for (let start = 0; start < bytes.length; start += BYTE_STRING_CHUNK) {
    chunks.push(String.fromCharCode(...bytes.subarray(start, start + BYTE_STRING_CHUNK)))
  }
  return `data:${version.mediaType};base64,${btoa(chunks.join(''))}`
}

/**
 * Bytes converted per `String.fromCharCode` call.
 *
 * A power of two below the argument-count ceiling every engine allows (the
 * lowest is 65535), chosen so the spread stays well clear of it rather than at
 * the edge.
 */
const BYTE_STRING_CHUNK = 0x8000

/** Type guard for tool-call blocks. */
function isToolCallBlock(block: ContentBlock): block is Extract<ContentBlock, { type: 'tool-call' }> {
  return block.type === 'tool-call'
}

/** A text or reasoning block — both carry a `text` string. */
type TextLikeBlock = Extract<ContentBlock, { type: 'text' }> | Extract<ContentBlock, { type: 'reasoning' }>

function blocksToText(blocks: readonly ContentBlock[]): string {
  return blocks
    .filter(block => block.type === 'text' || block.type === 'reasoning')
    .map(block => (block as TextLikeBlock).text ?? '')
    .join('')
}

function serializeAssistantToolCall(block: Extract<ContentBlock, { type: 'tool-call' }>): WireAssistantToolCall {
  return {
    id: String(block.id),
    type: 'function',
    function: { name: block.name, arguments: block.arguments },
  }
}

function serializeTool(tool: { name: string; description: string; parameters: Record<string, unknown> }): WireTool {
  return {
    type: 'function',
    function: { name: tool.name, description: tool.description, parameters: tool.parameters },
  }
}
