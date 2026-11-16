/**
 * Cutting a log at the Turn a message belongs to.
 *
 * A per-message share action lives at the **tail of a Turn** — that is where
 * the shell draws its action row (`TurnTailNodeView`, which the chat package
 * documents as "independent of Assistant placement"). So a cut is never made at
 * the message; it is made where the Turn closes.
 *
 * ## Why the cut cannot be at the message
 *
 * One Turn interleaves its messages with its steps:
 *
 * ```
 * step/start
 * user/message
 * assistant/message      ← the message the reader clicked
 * tool/call
 * tool/result
 * step/end
 * turn/end
 * ```
 *
 * Cutting at the message leaves `step/start` without its `step/end`, drops the
 * tool events the message refers to, and fails `validateStoredEvents` — the copy
 * would be rejected on import rather than truncated. Cutting at the `turn/end`
 * keeps every pairing the log requires.
 *
 * ## Where the boundary is found
 *
 * The last `turn/end` that closes the Turn the message was logged in, at or
 * after the message's own position. A message whose Turn never closed (the
 * session is mid-turn, or the reader is looking at an interrupted turn) has no
 * boundary: sharing it would send an unbalanced log, so nothing is cut and the
 * caller is told so.
 *
 * @module @huaweidevtools/aishell-dsh-share/truncate
 */

/** The subset of a stored event this module reads. */
interface LoggedEvent {
  readonly type: string
  readonly seq: number
  readonly data?: unknown
}

/** Where a cut can be made, or why it cannot. */
export type Cut =
  | { readonly ok: true, readonly lastSeq: number }
  | { readonly ok: false, readonly reason: 'message-not-found' | 'turn-not-complete' }

/**
 * The message id an event carries, if it carries one.
 *
 * `user/message` puts it at `data.id`; `assistant/message` nests the message
 * under `data.message`, because its envelope also holds the turn and step.
 *
 * @param event - one log entry.
 * @returns the id, or undefined when this event is not a message.
 */
function messageIdOf(event: LoggedEvent): string | undefined {
  if (event.type !== 'user/message' && event.type !== 'assistant/message') return undefined
  const data = event.data
  if (typeof data !== 'object' || data === null) return undefined
  const record = data as { readonly id?: unknown, readonly message?: unknown }
  if (record.message !== undefined) {
    if (typeof record.message !== 'object' || record.message === null) return undefined
    const nested = (record.message as { readonly id?: unknown }).id
    return typeof nested === 'string' ? nested : undefined
  }
  return typeof record.id === 'string' ? record.id : undefined
}

/**
 * Read the turn number an event belongs to.
 *
 * Most events name it in `data.turn`, but `user/message` does not: its payload
 * is the message alone — `{ content, source, role, id }`. A user message belongs
 * to whichever Turn is open where it sits, so the number is read from the
 * `turn/start` that precedes it.
 *
 * @param event - one log entry.
 * @param preceding - the events before it, in ascending seq order.
 * @returns the turn number, or undefined when none can be established.
 */
function turnOf(event: LoggedEvent, preceding: readonly LoggedEvent[]): unknown {
  if (typeof event.data === 'object' && event.data !== null) {
    const named = (event.data as { readonly turn?: unknown }).turn
    if (named !== undefined) return named
  }
  if (event.type !== 'user/message') return undefined
  for (let i = preceding.length - 1; i >= 0; i -= 1) {
    const earlier = preceding[i] as LoggedEvent
    if (earlier.type === 'turn/start') return turnOf(earlier, [])
  }
  return undefined
}

/**
 * Find where to cut a log so it ends with the Turn that holds one message.
 *
 * @param events - the complete log, in ascending seq order.
 * @param messageId - the durable id of the message the reader acted on.
 * @returns the last seq to keep, or why no such cut exists.
 */
export function cutForMessage(events: readonly LoggedEvent[], messageId: string): Cut {
  let index = -1
  for (let i = 0; i < events.length; i += 1) {
    if (messageIdOf(events[i] as LoggedEvent) === messageId) { index = i; break }
  }
  if (index === -1) return { ok: false, reason: 'message-not-found' }

  const message = events[index] as LoggedEvent
  const turn = turnOf(message, events.slice(0, index))
  // Without the number there is no way to find the closing boundary, and
  // guessing would be the bug this module exists to avoid.
  if (turn === undefined) return { ok: false, reason: 'turn-not-complete' }

  const end = events.find((event) => event.type === 'turn/end'
    && event.seq >= message.seq
    && turnOf(event, []) === turn)
  if (end === undefined) return { ok: false, reason: 'turn-not-complete' }

  return { ok: true, lastSeq: end.seq }
}

/**
 * Keep the events at or before a cut.
 *
 * @param events - the complete log, in ascending seq order.
 * @param lastSeq - the inclusive last seq to keep.
 * @returns the prefix.
 */
export function keepThrough<T extends { readonly seq: number }>(events: readonly T[], lastSeq: number): T[] {
  return events.filter((event) => event.seq <= lastSeq)
}