/**
 * Turning a share package into something a person can read.
 *
 * The preview shows what the conversation said, not what the log recorded: an
 * event type names nothing to a reader.
 *
 * ## Turns, and what a Turn hides
 *
 * The transcript is grouped the way the conversation itself is: a person's turn,
 * then one Turn of work, then the reply. Inside a Turn every Step is the same
 * three beats — the model's message, its `tool/call`, and the `tool/result` that
 * answered it — and a conversation of any length is mostly those beats. Shown
 * one line each they bury the words, which is what a reader is here to judge.
 *
 * So a Turn carries its work as a fold: collapsed, the steps are a count;
 * expanded, they are the sequence. This mirrors what the shell's own transcript
 * does, and it is the same decision, not a second one invented for this dialog.
 *
 * What the fold does **not** hold is the Turn's answer. A Turn ends by
 * concluding, and that conclusion is what a reader came to read — folded away,
 * the card shows a model that asks and confirms and never answers. The rule for
 * where the answer begins is the shell's too, and it is stated in `emit`.
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
 * ## One call, not two records
 *
 * A `tool/call` event and the `tool-call` block inside the message that asked
 * for it carry the same id — the log records the request twice. The block is
 * skipped here; the event is the one this reads, because it is where the
 * arguments are spelled out on their own rather than folded into a message.
 *
 * Pure, so the extraction rules can be asserted without a renderer.
 *
 * @module @huaweidevtools/aishell-dsh-share/client/preview
 */

import type { SharePackage } from '../package.ts'

/** One step of a Turn's work. */
export type PreviewStep =
  /** The model's message for this step, when it carried text. */
  | { readonly kind: 'message', readonly text: string }
  /** A tool invocation and what it returned. */
  | {
    readonly kind: 'tool'
    readonly name: string
    readonly arguments: string
    /**
     * What the tool returned, filled in when the result event arrives.
     *
     * Mutable because the call and its answer are two events that describe one
     * step: the log writes the invocation first, so the step exists before the
     * thing that completes it does.
     */
    result?: string
    isError?: true
  }

/**
 * One Turn of work, folded.
 *
 * `at` is the Turn's first event, so a list keyed on it survives a re-render
 * without reassigning keys by array position.
 */
export interface PreviewTurn {
  readonly kind: 'turn'
  readonly at: number
  /**
   * The steps that led to the answer — everything before the last one.
   *
   * The Step's own message is part of the work: the model saying what it is
   * about to try is process, not a reply. The reply is carried separately, see
   * {@link PreviewTurn.answer}.
   */
  readonly steps: readonly PreviewStep[]
  /**
   * What the Turn finally said, shown outside the fold.
   *
   * A Turn ends by answering. Folding that away leaves the reader looking at a
   * conversation where the model asks questions and never answers them, which
   * is the opposite of what the preview is for — so the answer is drawn where a
   * reader expects it and only the work that produced it is collapsed.
   *
   * Absent when the Turn's last Step still carried a tool call: an unfinished
   * Turn has not answered yet, and whatever text it produced along the way is
   * part of the work.
   */
  readonly answer?: string
}

/**
 * One item of the transcript.
 */
export type PreviewItem =
  /** What the person typed. */
  | { readonly kind: 'user', readonly at: number, readonly text: string }
  /** What the model said outside any tool work. */
  | { readonly kind: 'assistant', readonly at: number, readonly text: string }
  | PreviewTurn

/** A `user/message` event's data: the content blocks are flat on it. */
interface UserMessageData {
  readonly content?: unknown
  readonly source?: unknown
}

/** An `assistant/message` or `tool/result` event's data. */
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
  readonly callId?: unknown
  /** The Step that issued the call; the answer rule reads it. */
  readonly step?: unknown
}

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
 * Flatten a package into the transcript a reader sees.
 *
 * This walk only groups: it collects each Step's output under the Turn that
 * produced it. What those groups become — a set of replies, or a fold with an
 * answer beside it — is decided by `emit`, so the shape of the transcript is
 * stated in one place rather than spread across the loop.
 *
 * @param pkg - the share package.
 * @returns the transcript, in order.
 */
export function previewItems(pkg: SharePackage): PreviewItem[] {
  const items: PreviewItem[] = []
  /**
   * What each Step of the open Turn produced, and where it happened.
   *
   * The position is per Step, not per Turn: a Turn that answered without a tool
   * becomes one line per message, and lines that shared the Turn's position
   * would collide as list keys.
   */
  let steps: { at: number, produced: PreviewStep[] }[] = []
  let turnAt: number | undefined
  /** The Step the events arriving now belong to. */
  let step = 0
  /** The tool of the current Step, waiting for its result. */
  let pending: Extract<PreviewStep, { kind: 'tool' }> | undefined

  const bucket = (eventAt: number): { at: number, produced: PreviewStep[] } => {
    while (steps.length <= step) steps.push({ at: eventAt, produced: [] })
    return steps[step] as { at: number, produced: PreviewStep[] }
  }

  const close = (): void => {
    if (turnAt !== undefined) items.push(...emit(steps, turnAt))
    steps = []
    turnAt = undefined
    step = 0
    pending = undefined
  }

  for (const [eventAt, event] of pkg.events.entries()) {
    switch (event.type) {
      case 'turn/start':
      case 'turn/end': {
        // A boundary closes the previous group. `turn/end` is also the last
        // event of a Turn, so work is flushed here rather than when the next
        // event needs room: the loop can end with a group still open.
        close()
        break
      }
      case 'user/message': {
        const data = event.data as UserMessageData | undefined
        if (isHumanMessage(data)) {
          const text = textOf(data?.content)
          if (text !== '') items.push({ kind: 'user', at: eventAt, text })
        }
        break
      }
      case 'assistant/message': {
        const message = event.data as (WrappedMessageData & { step?: unknown }) | undefined
        step = typeof message?.step === 'number' ? message.step : step
        const text = textOf(message?.message?.content)
        if (text === '') break
        turnAt ??= eventAt
        bucket(eventAt).produced.push({ kind: 'message', text })
        break
      }
      case 'tool/call': {
        const data = event.data as ToolCallData | undefined
        const name = typeof data?.name === 'string' ? data.name : undefined
        if (name === undefined) break
        step = typeof data?.step === 'number' ? data.step : step
        turnAt ??= eventAt
        pending = { kind: 'tool', name, arguments: typeof data?.arguments === 'string' ? data.arguments : '' }
        bucket(eventAt).produced.push(pending)
        break
      }
      case 'tool/result': {
        // The result answers the call just before it, so it settles that Step
        // rather than becoming one of its own. The Step holds the same object
        // the accumulator does, so filling it in is what the transcript sees.
        if (pending === undefined) break
        const data = event.data as WrappedMessageData | undefined
        const result = textOf(data?.message?.content)
        if (result !== '') pending.result = result
        if (data?.message?.isError === true) pending.isError = true
        pending = undefined
        break
      }
      default:
        break
    }
  }
  close()
  return items
}

/** One Step's output, and where in the package it happened. */
interface TurnStep {
  readonly at: number
  readonly produced: readonly PreviewStep[]
}

/**
 * Turn one Turn's Steps into the items a reader sees.
 *
 * A Turn that used no tool is a reply, and each message in it is its own line,
 * positioned at the Step that wrote it. A Turn that used one is a fold, and what
 * goes in the fold depends on the answer rule: the last Step counts only when it
 * still carried a tool call, and when it did not, its text is what the Turn
 * concluded rather than another thing it did. Without that rule the transcript
 * shows a model asking questions and never answering them, because every reply
 * ends the Step that produced it.
 *
 * @param steps - the Turn's Steps, in order.
 * @param turnAt - the event the Turn began at.
 * @returns the items the Turn contributes.
 */
function emit(steps: readonly TurnStep[], turnAt: number): PreviewItem[] {
  // A Step that produced nothing — one that lived entirely in a reasoning block
  // — is not evidence of anything, and dropping it keeps the answer rule
  // looking at the last Step that actually did something.
  const populated = steps.filter((step) => step.produced.length > 0)
  const usedTool = populated.some((step) => step.produced.some((item) => item.kind === 'tool'))
  if (!usedTool) {
    return populated.flatMap((step) => step.produced.flatMap((item) =>
      item.kind === 'message' ? [{ kind: 'assistant', at: step.at, text: item.text } as const] : []))
  }
  const last = populated.at(-1)?.produced ?? []
  // The answer is the last Step's text, and only when that Step called no tool:
  // a Step that called one was still working, whatever it said on the way.
  const lastIsAnswer = !last.some((item) => item.kind === 'tool')
  const wordsOf = (produced: readonly PreviewStep[]): string =>
    produced.flatMap((item) => item.kind === 'message' ? [item.text] : []).join('')
  const answer = lastIsAnswer ? wordsOf(last) : ''
  return [{
    kind: 'turn',
    at: turnAt,
    steps: (lastIsAnswer ? populated.slice(0, -1) : populated).flatMap((step) => step.produced),
    ...answer === '' ? {} : { answer },
  }]
}