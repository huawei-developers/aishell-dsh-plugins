/**
 * Turning a share package into something a person can read.
 *
 * The preview shows what the conversation said, not what the log recorded: an
 * event type names nothing to a reader. Tool calls are folded into one line
 * each — they are history in the preview, and they are not runnable.
 *
 * Pure, so the extraction rules can be asserted without a renderer.
 *
 * @module @huaweidevtools/aishell-dsh-share/client/preview
 */

import type { ShareEvent, SharePackage } from '../package.ts'

/** Who a preview line is attributed to. */
export type PreviewRole = 'user' | 'assistant' | 'tool'

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
}

/** A line before its position is attached. */
type UnplacedLine = Omit<PreviewLine, 'at'>

/** A user or assistant message's data, as this module reads it. */
interface MessageData {
  readonly id?: unknown
  readonly role?: unknown
  readonly content?: unknown
}

/**
 * Read the text out of one message's content.
 *
 * Only `text` blocks carry anything a reader can see; images and file
 * attachments have no body here to render.
 *
 * @param content - the message's content blocks.
 * @returns the concatenated text.
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
 * Read one message event into a line.
 *
 * @param event - a `user/message` or `assistant/message` event.
 * @param role - the role the event carries.
 * @returns the line, or undefined when there is no text to show.
 */
function messageLine(event: ShareEvent, role: 'user' | 'assistant'): UnplacedLine | undefined {
  const data = event.data as MessageData | undefined
  if (role === 'user' && !isHumanMessage(data)) return undefined
  const text = textOf(data?.content)
  return text === '' ? undefined : { role, text }
}

/**
 * Read a tool call into one folded line.
 *
 * @param event - a `tool/call` event.
 * @returns the line naming the tool.
 */
function toolLine(event: ShareEvent): UnplacedLine | undefined {
  const data = event.data as { name?: unknown } | undefined
  const name = typeof data?.name === 'string' ? data.name : undefined
  return name === undefined ? undefined : { role: 'tool', text: name }
}

/**
 * Flatten a package into the lines a reader sees.
 *
 * @param pkg - the share package.
 * @returns the conversation, in order.
 */
export function previewLines(pkg: SharePackage): PreviewLine[] {
  const lines: PreviewLine[] = []
  pkg.events.forEach((event, at) => {
    const found = event.type === 'user/message'
      ? messageLine(event, 'user')
      : event.type === 'assistant/message'
        ? messageLine(event, 'assistant')
        : event.type === 'tool/call'
          ? toolLine(event)
          : undefined
    if (found !== undefined) lines.push({ at, ...found })
  })
  return lines
}