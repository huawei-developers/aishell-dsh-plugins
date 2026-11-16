/**
 * The share package: one conversation in a form that survives a round trip.
 *
 * Pure functions over plain JSON, so the selection rules and the rebuild
 * assumptions can be tested without a session store or a network.
 *
 * @module @huaweidevtools/aishell-dsh-share/package
 */

/** The package's shape, as stored and returned by the share service. */
export interface SharePackage {
  /** The writing plugin's version, e.g. `0.0.21`. Diagnostic only. */
  readonly version: string
  /** The conversation's title at share time. */
  readonly title: string
  /** When the source session was created, in Unix epoch milliseconds. */
  readonly createdAt: number
  /** The conversation's events, in order, without `seq` or `time`. */
  readonly events: readonly ShareEvent[]
}

/**
 * One event as it travels.
 *
 * `seq` and `time` are absent: the importer assigns a dense sequence from zero
 * and stamps the new session's own times.
 *
 * `surfaceOp` and `sourceEventSeqs` are carried, but **rewritten**: they name
 * positions in the source log, and the copy renumbers. Selection translates
 * them to positions in `events`, so the package is self-consistent — an
 * importer reads `sourceEventSeqs: [3]` as "the fourth event here", not as
 * "seq 3 of a log it cannot see". Leaving them untranslated makes every copy of
 * a conversation that used a tool fail validation, with the log's own
 * ordering rule reporting a citation of an event that has not arrived yet.
 */
export interface ShareEvent {
  readonly type: string
  readonly data: unknown
  readonly surfaceOp?: unknown
  readonly sourceEventSeqs?: readonly number[]
  readonly ignorable?: true
}

/**
 * The event types that make a conversation.
 *
 * The known types a session log can carry are mostly not conversation: they
 * describe one machine's local state — compaction, approvals, jobs, subagents,
 * hooks, telemetry, working-directory changes — and none of them can be
 * replayed elsewhere.
 *
 * `session/title` travels because it is the conversation's name: without it a
 * copy is labelled by its directory like every other unnamed session, and a
 * reader who imports three conversations sees three identical rows.
 *
 * `system/message` travels for a reason of its own, stated in
 * {@link selectEvents}: the copy cannot be continued without one.
 */
const CONVERSATION_EVENTS: ReadonlySet<string> = new Set([
  // Messages and their content.
  'user/message',
  'assistant/message',
  'tool/result',
  // The surface head — the one event that travels in a reduced shape.
  'system/message',
  // The invocation a tool result answers. Dropping it leaves a dangling callId.
  'tool/call',
  // Turn and step boundaries, which are what replay walks.
  'turn/start',
  'turn/end',
  'step/start',
  'step/end',
  // The conversation's name, which the sidebar shows instead of the directory.
  'session/title',
])

/** Whether an event belongs to the conversation rather than to local state. */
export function carriesConversation(type: string): boolean {
  return CONVERSATION_EVENTS.has(type)
}

/** The subset of a stored event this module reads. */
interface StoredEvent {
  readonly type: string
  readonly seq?: number
  /** Present in a stored log; not read here, and not carried. */
  readonly time?: number
  readonly data: unknown
  readonly surfaceOp?: unknown
  readonly sourceEventSeqs?: unknown
  readonly ignorable?: true
}

/**
 * Rewrite one event's seq references to positions in the carried list.
 *
 * Two kinds of event travel in a different shape than they were stored, and both
 * are the same requirement: the copy has to be a session DSH can keep writing to,
 * and the format states its rules about the surface over positions rather than
 * over content. See {@link selectEvents} for why the head exists at all.
 *
 * **The head travels with its content emptied.** The blocks are the rendered
 * prompt this machine assembled; the reader's copy has no use for them, and
 * carrying them would put one deployment's system prompt into another's session.
 * The envelope stays because the format validates the turn, step, role and id.
 *
 * **A compaction checkpoint travels as an append.** `compact-checkpoint` is a
 * `user/message` whose `surfaceOp` replaces the span its summary condensed. The
 * summary is local state and did not travel, so the range is meaningless here —
 * as it is for every other non-surviving range, which {@link remapSurfaceOp}
 * already degrades to `append`. Forced here as well because that fallback is not
 * enough: the format also requires the checkpoint's owning `compaction/start`,
 * exactly the local event that did not travel. Carried as a replace, a checkpoint
 * fails `compaction checkpoint has no matching compaction/start`.
 *
 * @param event - the stored event.
 * @param renumber - source seq → position in the selection.
 * @param at - this event's position in the selection.
 * @returns the event as it travels.
 */
function carried(event: StoredEvent, renumber: ReadonlyMap<number, number>, at: number): ShareEvent {
  const checkpoint = event.type === 'user/message' && messageSourceKind(event.data) === 'compact-checkpoint'
  const surfaceOp = checkpoint ? 'append' : remapSurfaceOp(event.surfaceOp, renumber, at)
  const sourceEventSeqs = checkpoint ? undefined : remapSourceSeqs(event.sourceEventSeqs, renumber, at)
  return {
    type: event.type,
    data: event.type === 'system/message'
      ? blankedHead(event.data)
      : event.type === 'session/title' ? rebasedTitle(event.data, renumber, at) : event.data,
    ...surfaceOp === undefined ? {} : { surfaceOp },
    ...sourceEventSeqs === undefined ? {} : { sourceEventSeqs },
    ...event.ignorable === undefined ? {} : { ignorable: event.ignorable },
  }
}

/**
 * Empty a system message's content, keeping the envelope the format reads.
 *
 * An empty content array is how a head holds a surface position without
 * projecting a message — `deriveEventMessage` returns null for one — so nothing
 * this module carries can reach the model as if it were part of the
 * conversation.
 *
 * @param data - a `system/message` event's data.
 * @returns the same envelope with no content.
 */
function blankedHead(data: unknown): unknown {
  if (typeof data !== 'object' || data === null) return data
  const record = data as { readonly message?: unknown }
  if (typeof record.message !== 'object' || record.message === null) return data
  return { ...record, message: { ...(record.message as Record<string, unknown>), content: [] } }
}

/**
 * Re-anchor a title event's cited messages onto the selection.
 *
 * @param data - the title event's data.
 * @param renumber - source seq → position in the selection.
 * @param at - this event's position in the selection.
 * @returns the data with `messageSeqs` translated.
 */
function rebasedTitle(data: unknown, renumber: ReadonlyMap<number, number>, at: number): unknown {
  if (typeof data !== 'object' || data === null) return data
  const record = data as Record<string, unknown>
  if (!Array.isArray(record['messageSeqs'])) return data
  const cited: number[] = []
  for (const seq of record['messageSeqs']) {
    if (typeof seq !== 'number') continue
    const found = renumber.get(seq)
    if (found !== undefined && found < at) cited.push(found)
  }
  return { ...record, messageSeqs: cited }
}

/**
 * Translate a surface operation onto the selection.
 *
 * A `replace` whose range does not survive in full becomes an `append`: the
 * nodes it shadowed are not here, so there is no range to replace. That is a
 * faithful reading rather than a repair — the shadowed content was local-only
 * state (a compaction summary) and did not travel, so the message simply
 * joins the surface where the copy begins.
 *
 * @param op - the stored `surfaceOp`.
 * @param renumber - source seq → position in the selection.
 * @param at - this event's position in the selection.
 * @returns the travelling operation, or undefined when there was none.
 */
function remapSurfaceOp(
  op: unknown,
  renumber: ReadonlyMap<number, number>,
  at: number,
): unknown {
  if (op === undefined) return undefined
  if (op === 'append') return 'append'
  if (typeof op !== 'object' || op === null) return undefined
  const range = op as { readonly startSeq?: unknown, readonly endSeq?: unknown }
  const start = typeof range.startSeq === 'number' ? renumber.get(range.startSeq) : undefined
  const end = typeof range.endSeq === 'number' ? renumber.get(range.endSeq) : undefined
  if (start === undefined || end === undefined || start >= at || end >= at) return 'append'
  return { op: 'replace', startSeq: start, endSeq: end }
}

/**
 * Translate cited source seqs onto the selection.
 *
 * A citation of an event that did not travel is dropped. It named something
 * the copy does not contain, and pointing at whatever now occupies that
 * position would be a false claim about provenance.
 *
 * @param cited - the stored `sourceEventSeqs`.
 * @param renumber - source seq → position in the selection.
 * @param at - this event's position in the selection.
 * @returns the translated seqs, or undefined when none survive.
 */
function remapSourceSeqs(
  cited: unknown,
  renumber: ReadonlyMap<number, number>,
  at: number,
): number[] | undefined {
  if (!Array.isArray(cited)) return undefined
  const translated: number[] = []
  for (const seq of cited) {
    if (typeof seq !== 'number') continue
    const found = renumber.get(seq)
    if (found !== undefined && found < at) translated.push(found)
  }
  return translated.length === 0 ? undefined : translated
}

/**
 * Select the conversation's events and re-anchor their references.
 *
 * Positions are decided in two passes because a title may have to be dropped:
 * it is carried only when it can still cite the human message it was derived
 * from. Numbering first and dropping afterwards would leave every later
 * reference pointing one position early.
 *
 * The surface head is handled before numbering. The format protects a session's
 * first surface node: once any surface node exists, a later `system/message` may
 * only appear as a replace of that head. A copy therefore has to *have* a head,
 * or it is a session that can be read once and never written to again — an
 * import without one passes, then the reader's next turn renders a prompt, finds
 * no system node to put it in, appends one, and the log is refused by
 * `system/message requires a protected first surface head`.
 *
 * So exactly one `system/message` travels, and it is the source's first
 * (`append`) head: a later one re-baselines the head, and a copy has nothing to
 * re-baseline. A source with surface nodes but no head at all — a session whose
 * head was compacted away — gets an empty one from {@link withSyntheticHead}.
 *
 * @param events - the source session's log.
 * @returns the events that travel, in their original order.
 */
export function selectEvents(events: readonly StoredEvent[]): ShareEvent[] {
  const ordered = events.map((event, index) => ({ event, seq: event.seq ?? index }))
  const firstHead = ordered.find(({ event }) => event.type === 'system/message' && event.surfaceOp === 'append')

  const kept = ordered
    .filter(({ event }) => carriesConversation(event.type))
    .filter(({ event }) => event.type !== 'system/message' || event === firstHead?.event)

  // Read once: a title filter that recomputed this would walk the kept list per
  // title event.
  const humanMessages = humanMessagesOf(kept)
  const travelling = kept.filter(({ event }) => event.type !== 'session/title' || titleSurvives(event.data, humanMessages))

  // Always called, not branched on `firstHead`: the guard below is the one
  // statement of when a head is missing, so a caller cannot disagree with it.
  const withHead = withSyntheticHead(travelling)

  const renumber = new Map<number, number>()
  withHead.forEach((entry, position) => {
    if (entry.seq !== undefined) renumber.set(entry.seq, position)
  })

  return withHead.map(({ event }, position) => carried(event, renumber, position))
}

/** One travelling event, with the source position it came from. */
interface Travelling {
  readonly event: StoredEvent
  /** Absent for an event this module adds rather than carries. */
  readonly seq?: number
}

/**
 * The source seqs of the human messages that travel.
 *
 * @param kept - the events selected so far.
 * @returns the seqs of the `user/message` events a person wrote.
 */
function humanMessagesOf(kept: readonly { readonly event: StoredEvent, readonly seq: number }[]): ReadonlySet<number> {
  const humanMessages = new Set<number>()
  for (const { event, seq } of kept) {
    if (event.type !== 'user/message') continue
    if (messageSourceKind(event.data) === 'user') humanMessages.add(seq)
  }
  return humanMessages
}

/** Surface types, in the order the head can precede them. */
const SURFACE_EVENTS: ReadonlySet<string> = new Set([
  'user/message',
  'assistant/message',
  'tool/result',
])

/**
 * Add an empty head to a conversation that has surface nodes but no head.
 *
 * A head always sits directly after the `step/start` that opens the step it
 * names — the format validates its turn and step against that open step, so the
 * coordinates come from the `step/start` and a head anywhere else is rejected.
 * The one composed here goes in the same place: after the `step/start` that opens
 * the step holding the conversation's first surface node, which is where the
 * sender's own head sat.
 *
 * Empty rather than a placeholder sentence: an empty content array is how a
 * head holds a position without projecting a message, so nothing this module
 * invents can reach the model as if a person had said it.
 *
 * @param travelling - the events selected so far, in log order.
 * @returns the same list, with one head inserted when one is needed.
 */
function withSyntheticHead(travelling: readonly Travelling[]): Travelling[] {
  if (travelling.some(({ event }) => event.type === 'system/message')) return [...travelling]
  const firstSurface = travelling.findIndex(({ event }) => SURFACE_EVENTS.has(event.type))
  if (firstSurface === -1) return [...travelling]
  for (let index = firstSurface - 1; index >= 0; index -= 1) {
    const entry = travelling[index]
    if (entry?.event.type !== 'step/start') continue
    const step = entry.event.data as { readonly turn?: unknown, readonly step?: unknown } | undefined
    if (typeof step?.turn !== 'number' || typeof step.step !== 'number') return [...travelling]
    const head: StoredEvent = {
      type: 'system/message',
      data: {
        turn: step.turn,
        step: step.step,
        message: { role: 'system', content: [], source: { kind: 'system-prompt' }, id: `share-head-${step.turn}-${step.step}` },
      },
      surfaceOp: 'append',
    }
    return [...travelling.slice(0, index + 1), { event: head }, ...travelling.slice(index + 1)]
  }
  // No open step to sit in means the log has no shape this can join; leaving it
  // alone is honest, and the import's own validation is what reports it.
  return [...travelling]
}

/**
 * Read a message event's `source.kind`.
 *
 * @param data - the event's data.
 * @returns the kind, or undefined when the data is not a message.
 */
function messageSourceKind(data: unknown): unknown {
  if (typeof data !== 'object' || data === null) return undefined
  const source = (data as { readonly source?: unknown }).source
  if (typeof source !== 'object' || source === null) return undefined
  return (source as { readonly kind?: unknown }).kind
}

/**
 * Whether a title can still name a message in this copy.
 *
 * The invariant service refuses an automatically sourced title with no
 * citations, and refuses a citation that does not name an earlier human
 * `user/message`. A title whose messages did not travel is dropped instead of
 * carried in a state the copy would reject — the sidebar then falls back to
 * the directory, which is the same label the session would have had unnamed.
 *
 * @param data - the title event's data.
 * @param humanMessages - source seqs of the human messages that travel.
 * @returns whether the title can be carried.
 */
function titleSurvives(data: unknown, humanMessages: ReadonlySet<number>): boolean {
  if (typeof data !== 'object' || data === null) return false
  const record = data as { readonly title?: unknown, readonly source?: unknown, readonly messageSeqs?: unknown }
  if (typeof record.title !== 'string') return false
  const kind = (record.source as { readonly kind?: unknown } | undefined)?.kind
  if (kind === 'user') return true
  if (!Array.isArray(record.messageSeqs)) return false
  return record.messageSeqs.some((seq) => typeof seq === 'number' && humanMessages.has(seq))
}

/**
 * Build a package from one session.
 *
 * @param source - what the Host read from the session store.
 * @param version - the writing plugin's version.
 * @returns the package a share service stores.
 */
export function buildPackage(
  source: {
    readonly title: string
    readonly createdAt: number
    readonly events: readonly StoredEvent[]
  },
  version: string,
): SharePackage {
  return {
    version,
    title: source.title,
    createdAt: source.createdAt,
    events: selectEvents(source.events),
  }
}

/**
 * Read a package out of an untrusted body.
 *
 * The share service returns whatever was uploaded, so nothing about the shape
 * is trusted. A body that does not describe a package is rejected here rather
 * than three layers deeper, where the failure would name a session store
 * instead of a bad link.
 *
 * `ignorable` is accepted only as a literal `true`. Coercing a present field
 * to `true` would take an event the writer marked required and let this build
 * skip it, which is the one thing the marker exists to prevent: a reader
 * meeting an unrecognized required type must refuse, not shrug.
 *
 * @param value - the parsed JSON body.
 * @returns the package, or undefined when the body is not one.
 */
export function readPackage(value: unknown): SharePackage | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const record = value as Record<string, unknown>
  if (typeof record['title'] !== 'string') return undefined
  if (typeof record['createdAt'] !== 'number' || !Number.isSafeInteger(record['createdAt'])) return undefined
  if (typeof record['version'] !== 'string') return undefined
  if (!Array.isArray(record['events'])) return undefined

  const events: ShareEvent[] = []
  for (const entry of record['events']) {
    if (typeof entry !== 'object' || entry === null) return undefined
    const event = entry as Record<string, unknown>
    if (typeof event['type'] !== 'string' || event['type'] === '') return undefined
    const sourceEventSeqs = event['sourceEventSeqs']
    events.push({
      type: event['type'],
      data: event['data'],
      ...event['surfaceOp'] === undefined ? {} : { surfaceOp: event['surfaceOp'] },
      ...sourceEventSeqs === undefined
        ? {}
        : { sourceEventSeqs: Array.isArray(sourceEventSeqs)
          ? sourceEventSeqs.filter((seq): seq is number => typeof seq === 'number')
          : [] },
      ...event['ignorable'] === true ? { ignorable: true } : {},
    })
  }

  return {
    version: record['version'],
    title: record['title'],
    createdAt: record['createdAt'],
    events,
  }
}

/**
 * Give travelling events their log envelope.
 *
 * The importer assigns a dense sequence from zero and stamps one import time
 * across the whole log — the events happened in this session at the moment it
 * was created, and the source session's wall clock is not this one's.
 *
 * References arrive already expressed as positions in this list, so they carry
 * over unchanged. Positions that would point forward or past the list are
 * dropped anyway: the package came from a service, and a reference that
 * violates the log's own ordering rule would make the whole import fail on a
 * body this code could have refused field by field.
 *
 * @param events - the package's events.
 * @param importedAt - the timestamp to stamp, in Unix epoch milliseconds.
 * @returns events shaped as a session log, ready for validation.
 */
export function toStoredEvents(events: readonly ShareEvent[], importedAt: number): unknown[] {
  return events.map((event, index) => ({
    type: event.type,
    seq: index,
    time: importedAt,
    data: event.data,
    ...event.surfaceOp === undefined
      ? {}
      : { surfaceOp: isSelfRebased(event.surfaceOp, index) ? event.surfaceOp : 'append' },
    ...event.sourceEventSeqs === undefined
      ? {}
      : { sourceEventSeqs: event.sourceEventSeqs.filter((seq) => seq < index) },
    ...event.ignorable === undefined ? {} : { ignorable: true },
  }))
}

/**
 * Whether a `replace` range still points backwards at this event's position.
 *
 * @param op - the package's surface operation.
 * @param at - the event's position in the rebuilt log.
 * @returns true when the range is usable as written.
 */
function isSelfRebased(op: unknown, at: number): boolean {
  if (op === 'append') return false
  if (typeof op !== 'object' || op === null) return false
  const range = op as { readonly startSeq?: unknown, readonly endSeq?: unknown }
  return typeof range.startSeq === 'number' && typeof range.endSeq === 'number'
    && range.startSeq <= range.endSeq && range.endSeq < at
}
