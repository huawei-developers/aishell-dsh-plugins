/**
 * Turning a share package into something a person can read.
 *
 * The preview shows what the conversation said, not what the log recorded: an
 * event type names nothing to a reader. A tool invocation becomes two lines —
 * the call and its result — because a reader has to see both ends to judge
 * whether the tool did what was asked.
 *
 * ## Where each event keeps its words
 *
 * The log does not use one shape for a message. What a person typed sits flat on
 * the event's `data`; what the model or a tool produced sits under
 * `data.message`. Reading the same path for both is how an assistant reply
 * becomes an empty line with nothing failing, so each reader below reads from
 * where its own writer puts it.
 *
 * A content block is identified by its own `type` tag. Only a `text` block
 * carries words for a reader: `reasoning` is the model thinking aloud, and
 * `image` and `file` reference attachments this preview does not resolve.
 *
 * Pure, so the extraction rules can be asserted without a renderer.
 *
 * @module @huaweidevtools/aishell-dsh-share/client/preview
 */

import type { ShareEvent, SharePackage } from '../package.ts'

/**
 * Who a preview line is attributed to.
 *
 * The last two reuse DSH's own tags for the two halves of a tool invocation —
 * the content-block types `tool-call` and `tool-result` — so the preview and the
 * log speak one vocabulary rather than two.
 */
export type PreviewRole = 'user' | 'assistant' | 'tool-call' | 'tool-result'

/** One line of the preview. */
export interface PreviewLine {
  /**
   * The event's position in the package.
   *
   * Stable for a given package, so a list keyed on it survives a re-render
   * without reassigning keys by array position.
   */
  readonly at: number
  /** Who is speaking, or what the application is reporting. */
  readonly role: PreviewRole
  /** The text to show. */
  readonly text: string
  /** Set on a tool result the tool itself reported as an error. */
  readonly isError?: true
}

/** A line before its position is attached. */
type UnplacedLine = Omit<PreviewLine, 'at'>

/**
 * Read the text out of a content-block list.
 *
 * @param content - a message's content blocks.
 * @returns the concatenated text of its `text` blocks.
 */
function textOf(content: unknown): string {
  if (!Array.isArray(content)) return ''
  const parts: string[] = []
  for (const block of content) {
    if (typeof block !== 'object' || block === null) continue
    const record = block as Record<string, unknown>
    if (record['type'] === 'text' && typeof record['text'] === 'string') parts.push(record['text'])
  }
  return parts.join('')
}

/** A `user/message` event's data: the content blocks are flat on it. */
interface UserMessageData {
  readonly content?: unknown
  readonly source?: unknown
}

/**
 * An `assistant/message` or `tool/result` event's data.
 *
 * Both wrap a message, and the message is where the content blocks and the
 * error flag live. A user turn is flat instead, which is why its reader takes no
 * part of this.
 */
interface WrappedMessageData {
  readonly message?: {
    readonly content?: unknown
    readonly isError?: unknown
  }
}

/** A `tool/call` event's data. */
interface ToolCallData {
  readonly name?: unknown
  readonly arguments?: unknown
}

/**
 * Whether a user message is something a person typed.
 *
 * A session log fills `user/message` with more than the human's words: the
 * runtime context snapshot, the skill catalog, and a time sample are all
 * `user/message` events, each marked by `source.kind`. They are scaffolding the
 * application wrote, not the conversation — the preview exists so a reader can
 * judge what they are about to import, and a page of harness boilerplate
 * attributed to the sender obscures exactly that.
 *
 * @param data - the message event's data.
 * @returns true when a person wrote it.
 */
function isHumanMessage(data: unknown): boolean {
  if (typeof data !== 'object' || data === null) return false
  const source = (data as { readonly source?: unknown }).source
  if (typeof source !== 'object' || source === null) return false
  return (source as { readonly kind?: unknown }).kind === 'user'
}

/**
 * Read a turn the person typed.
 *
 * @param event - a `user/message` event.
 * @returns the line, or undefined when nothing a person wrote is in it.
 */
function userLine(event: ShareEvent): UnplacedLine | undefined {
  const data = event.data as UserMessageData | undefined
  if (!isHumanMessage(data)) return undefined
  const text = textOf(data?.content)
  return text === '' ? undefined : { role: 'user', text }
}

/**
 * Read a turn the model wrote.
 *
 * @param event - an `assistant/message` event.
 * @returns the line, or undefined when the reply carried no text.
 */
function assistantLine(event: ShareEvent): UnplacedLine | undefined {
  const text = textOf((event.data as WrappedMessageData | undefined)?.message?.content)
  return text === '' ? undefined : { role: 'assistant', text }
}

/**
 * Read a tool call into one line.
 *
 * The arguments are part of the line because they are what say whether the call
 * was plausible. A bare tool name is the least informative half of the pair,
 * and a reader judging a conversation has no other way to see what was asked.
 *
 * @param event - a `tool/call` event.
 * @returns the line naming the tool and its arguments.
 */
function toolCallLine(event: ShareEvent): UnplacedLine | undefined {
  const data = event.data as ToolCallData | undefined
  const name = typeof data?.name === 'string' ? data.name : undefined
  if (name === undefined) return undefined
  const args = typeof data?.arguments === 'string' ? data.arguments : ''
  return { role: 'tool-call', text: args === '' ? name : `${name}(${args})` }
}

/**
 * Read a tool result into one line.
 *
 * @param event - a `tool/result` event.
 * @returns the line carrying what the tool returned.
 */
function toolResultLine(event: ShareEvent): UnplacedLine | undefined {
  const data = event.data as WrappedMessageData | undefined
  const text = textOf(data?.message?.content)
  if (text === '') return undefined
  return {
    role: 'tool-result',
    text,
    ...data?.message?.isError === true ? { isError: true } : {},
  }
}

/**
 * Read one event into a line, by its type.
 *
 * A switch rather than a chain of ternaries: the event types are a closed set
 * this module answers for, and a shape that names each one is readable at a
 * glance. Every other type — turn and step boundaries, the title, whatever a
 * future log adds — has no line, which is what the absent default says.
 *
 * @param event - one event from the package.
 * @returns the line it contributes, or undefined when it contributes none.
 */
function lineOf(event: ShareEvent): UnplacedLine | undefined {
  switch (event.type) {
    case 'user/message': return userLine(event)
    case 'assistant/message': return assistantLine(event)
    case 'tool/call': return toolCallLine(event)
    case 'tool/result': return toolResultLine(event)
    default: return undefined
  }
}

/**
 * Flatten a package into the lines a reader sees.
 *
 * @param pkg - the share package.
 * @returns the conversation, in order.
 */
export function previewLines(pkg: SharePackage): PreviewLine[] {
  const lines: PreviewLine[] = []
  for (const [at, event] of pkg.events.entries()) {
    const found = lineOf(event)
    if (found !== undefined) lines.push({ at, ...found })
  }
  return lines
}