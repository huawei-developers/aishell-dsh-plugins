/**
 * Client half of the permission-mode switch, shared by both chips.
 *
 * The mode lives in the host process (`aishell-deploy`), one per Session. A
 * Host route reads and writes it; this module owns the fetch and the state hook
 * so the composer chip and the hero chip cannot drift apart.
 *
 * @module @huaweidevtools/aishell-dsh-client-credentials/client/permission-mode
 */

import { useEffect, useState } from 'react'

/**
 * Host permission route, written document-relative for the same reason as the
 * credential route: the served index carries `<base href="./">`, so the
 * request lands on the origin that holds the browser session cookie the
 * route's authentication fence requires.
 */
export const PERMISSION_ROUTE = 'api/aishell/permission'

/** The two modes, as the server spells them. */
export type PermissionMode = 'read_only' | 'read_write'

/**
 * What a click on the mode button should do.
 *
 * `'confirm'` — open the risk gate and wait; `'apply'` — flip now; `'none'` —
 * the control is not actionable.
 */
export type ToggleOutcome = 'confirm' | 'apply' | 'none'

/**
 * Decide what a click does, from the mode in effect.
 *
 * Exported and pure so the direction that escalates is testable without a DOM
 * renderer — see `tests/permission-gate.spec.ts`. The asymmetry is the whole
 * point: read-write widens what the agent may do to a real account, so it asks
 * first; read-only narrows it, so it does not.
 *
 * An unknown mode is `'none'` rather than `'confirm'`: it is not read-only, and
 * offering the escalation gate against a session that may already be in
 * read-write would ask the person to approve a mode they are already in.
 *
 * @param mode - the mode in effect, or `undefined` before one is read.
 * @returns what the click should do.
 */
export function toggleOutcome(mode: PermissionMode | undefined): ToggleOutcome {
  if (mode === undefined) return 'none'
  return mode === 'read_only' ? 'confirm' : 'apply'
}

/**
 * Whether the gate's confirm button may write.
 *
 * One condition, named rather than inlined, because the chips and the hook must
 * agree on it — a chip that enabled the button on a different condition would
 * let an unacknowledged flip through.
 *
 * @param acknowledged - the acknowledgement box's state.
 * @returns whether the read-write flip may run.
 */
export function mayApply(acknowledged: boolean): boolean {
  return acknowledged
}

/** Narrow an unknown value to a mode. */
function asMode(value: unknown): PermissionMode | undefined {
  return value === 'read_only' || value === 'read_write' ? value : undefined
}

/**
 * Read one Session's mode from the Host route.
 *
 * @param sessionId - the conversation the chip is drawn in. Required: the route
 *        refuses a request that names none rather than answering with a
 *        process-wide value the chip would render as this conversation's own.
 * @returns the mode, or `undefined` when it could not be read — a broken link
 *          must not be rendered as a working lock, so an unreadable mode is
 *          reported as unknown, never as `read_only`.
 */
export async function readPermissionMode(sessionId: string): Promise<PermissionMode | undefined> {
  try {
    const response = await fetch(`${PERMISSION_ROUTE}?session=${encodeURIComponent(sessionId)}`)
    const body = await response.json() as { ok?: boolean; mode?: unknown }
    if (body.ok !== true) return undefined
    return asMode(body.mode)
  } catch {
    return undefined
  }
}

/**
 * Delays between read attempts while the mode is unknown.
 *
 * A Host answers a read once `api/aishell/permission` is registered; while the
 * route is absent the answer is `undefined`. A conversation the browser
 * restores can reach the page inside that window, so the schedule below gives
 * the read a second attempt: short at first, because the route appears within
 * a round trip of the Host being ready, and longer as the wait goes on, because
 * each attempt costs a request.
 *
 * The list is finite: a mode that stays unreadable is answered by the manual
 * re-read on the control, not by a request every few seconds for the life of
 * the page. Together the delays cover roughly twenty seconds of start-up.
 */
export const MODE_READ_RETRY_DELAYS_MS = [200, 500, 1000, 2000, 3000, 5000, 8000] as const

/**
 * How long to wait before the next read, given how many have failed.
 *
 * @param failedAttempts - consecutive reads that returned no mode.
 * @returns the delay in milliseconds; the final entry repeats.
 */
export function modeReadRetryDelay(failedAttempts: number): number {
  const last = MODE_READ_RETRY_DELAYS_MS.length - 1
  return MODE_READ_RETRY_DELAYS_MS[Math.min(Math.max(failedAttempts, 0), last)]!
}

/** What {@link readPermissionModeUntilKnown} reads through. */
export interface ModeReadDeps {
  /** One attempt; resolves `undefined` when it could not answer. */
  readonly read: () => Promise<PermissionMode | undefined>
  /**
   * Whether the caller is still mounted.
   *
   * Checked before each retry, so a read belongs to the surface that started
   * it: a chip that unmounted stops asking, and no request goes out naming a
   * conversation no page is showing.
   */
  readonly isLive: () => boolean
  /** Wait between attempts; injectable so a spec drives the schedule directly. */
  readonly sleep?: (ms: number) => Promise<void>
}

/**
 * Read the mode, retrying over the start-up window.
 *
 * A successful read is the server's answer and ends the loop, so the ordinary
 * case costs one request. Retries cover the interval in which the Host has not
 * registered the route yet and answers `undefined`; a mode that has been read
 * is final until the person changes it.
 *
 * Attempts are bounded by {@link MODE_READ_RETRY_DELAYS_MS}. `undefined` then
 * means "still unknown", not "the mode is absent", and the control stays
 * interactive so the person can ask again without reloading the page.
 *
 * @param deps - the read, the liveness check, and an optional sleep.
 * @returns the mode once one is read, or `undefined` when the caller went away
 *          or the attempts ran out.
 */
export async function readPermissionModeUntilKnown(
  deps: ModeReadDeps,
): Promise<PermissionMode | undefined> {
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>(resolve => { setTimeout(resolve, ms) }))
  // One attempt at a time is the shape of the schedule: a delay follows an
  // attempt that answered nothing, so overlapping attempts collapse the
  // schedule into a burst of reads made at the same moment. Both `await`s below
  // carry their own suppression for that reason.
  //
  // The loop makes one attempt more than there are delays, so the last wait is
  // followed by a read rather than spent on nothing.
  for (let failed = 0; failed <= MODE_READ_RETRY_DELAYS_MS.length; failed += 1) {
    // oxlint-disable-next-line no-await-in-loop
    const mode = await deps.read()
    if (mode !== undefined) return mode
    if (!deps.isLive() || failed === MODE_READ_RETRY_DELAYS_MS.length) return undefined
    // oxlint-disable-next-line no-await-in-loop
    await sleep(modeReadRetryDelay(failed))
    if (!deps.isLive()) return undefined
  }
  /* v8 ignore next -- the loop returns on the final iteration */
  return undefined
}

/**
 * Write one Session's mode through the Host route.
 *
 * @param sessionId - the conversation the switch belongs to.
 * @param mode - the mode to apply.
 * @returns the mode the server reports afterwards, or `undefined` on failure.
 */
export async function writePermissionMode(
  sessionId: string,
  mode: PermissionMode,
): Promise<PermissionMode | undefined> {
  try {
    const response = await fetch(PERMISSION_ROUTE, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ session: sessionId, mode }),
    })
    const body = await response.json() as { ok?: boolean; mode?: unknown }
    if (body.ok !== true) return undefined
    return asMode(body.mode)
  } catch {
    return undefined
  }
}

/** State and toggle for a permission-mode control. */
export interface PermissionModeControl {
  /** Mode in effect, or `undefined` while unknown. */
  readonly mode: PermissionMode | undefined
  /** True while a write is in flight. */
  readonly busy: boolean
  /**
   * Handle one click on the mode button.
   *
   * A flip **to read-write** is the one that changes what the agent may do to a
   * real cloud account, so this asks for confirmation first and only writes
   * once the person acknowledges. A flip back to read-only gives up access,
   * which needs no warning, so it applies immediately.
   *
   * No-op while unknown or busy. A press on an unknown-mode control belongs to
   * {@link reread}: there is no current mode to flip away from, and the control
   * that reaches this function has one meaning per state.
   */
  readonly toggle: () => void
  /**
   * The risk confirmation's state, or `undefined` when it is closed.
   *
   * Present only while a read-write flip is waiting on the person. It belongs
   * with the mode state rather than beside the button because opening the gate
   * and later writing the mode are one gesture split across a dialog: the chip
   * that asked has to still be the one that writes when the person confirms.
   */
  readonly confirmation: PermissionConfirmation | undefined
  /** Dismiss the confirmation without flipping. */
  readonly cancelConfirmation: () => void
  /** Apply the awaited read-write flip; the confirmation must be open. */
  readonly confirmToggle: () => void
  /**
   * Read the mode again, for a control showing "unavailable".
   *
   * Starts a fresh read. Its first attempt is immediate, so a Host that has
   * registered the route since answers within a round trip and the control
   * updates at once; a Host still not ready resumes the schedule from its
   * shortest delay, which keeps a press immediate rather than making it wait
   * out a delay that a previous read already used.
   *
   * One read runs at a time: the new generation unmounts the previous effect
   * first, whose loop stops before its next retry, so repeated presses cannot
   * accumulate loops.
   */
  readonly reread: () => void
}

/** The gate shown before a flip to read-write. */
export interface PermissionConfirmation {
  /** Whether the acknowledgement box is ticked; the confirm button is dead until it is. */
  readonly acknowledged: boolean
  /** Tick or untick the acknowledgement box. */
  readonly setAcknowledged: (acknowledged: boolean) => void
}

/**
 * Subscribe a control to the permission mode.
 *
 * Reads on mount, and reads again when the person asks. The mode is server
 * state that only a person changes, so there is no poll: each surface re-reads
 * on its own mount, and a press on an unknown-mode control is the one other
 * trigger.
 *
 * ## Why the read retries
 *
 * The mode lives in the Host process, and a page can render before that process
 * has put `api/aishell/permission` in place — a restored conversation reaches
 * the browser before the Host finishes registering its routes. A read in that
 * window answers nothing about the mode, so the first read retries over a short
 * schedule rather than reporting "unknown" from one attempt. The control a
 * person presses reads again, which covers a window that was still too early.
 *
 * ## Why the confirmation lives here rather than in a chip
 *
 * Each chip calls this hook for itself, so nothing here is shared React state;
 * what decided the placement is the shape of the interaction, not the count of
 * callers. A flip and its confirmation are one gesture split across a dialog,
 * and the fact that has to survive the split is "a read-write write is awaiting
 * acknowledgement". Kept in a chip, that fact dies with a remount — and the
 * chips do remount: the hero chip stops rendering the moment the first turn is
 * accepted, so a confirmation opened on a blank session would lose its
 * acknowledgement the instant the session existed.
 *
 * Holding it with the mode also keeps the write in one place: `confirmToggle`
 * closes the gate and calls the same `apply` that `toggle` uses, so a confirmed
 * flip and an immediate one cannot diverge in how they report the server's
 * answer.
 *
 * Two mounts do not run concurrently today — the hero chip gates on
 * `session.blank` and the composer chip needs a session — so this is not two
 * dialogs racing over one value. It is one hook whose surface can be swapped
 * under it.
 *
 * @param sessionId - the conversation whose mode this control reads and writes.
 *   One per chip: the mode belongs to a Session, so the hook cannot answer
 *   without knowing which.
 * @returns the current mode, a busy flag, the gated toggle, and the
 *   confirmation state for a pending read-write flip.
 */
export function usePermissionMode(sessionId: string): PermissionModeControl {
  const [mode, setMode] = useState<PermissionMode | undefined>(undefined)
  const [busy, setBusy] = useState(false)
  const [confirmation, setConfirmation] = useState<PermissionConfirmation | undefined>(undefined)
  /**
   * Bumped by {@link reread} to run the read again.
   *
   * A counter rather than a flag, so each press is a state change: a flag
   * returned to `false` on completion either swallows a press made during a
   * read or re-runs the effect on a value that did not change. The previous
   * effect's cleanup runs before the new one, so its loop stops rather than
   * overlapping.
   */
  const [readGeneration, setReadGeneration] = useState(0)

  useEffect(() => {
    let live = true
    void (async () => {
      const read = await readPermissionModeUntilKnown({
        read: () => readPermissionMode(sessionId),
        isLive: () => live,
      })
      if (live && read !== undefined) setMode(read)
    })()
    return () => { live = false }
  }, [sessionId, readGeneration])

  /** Write the mode the control should land on, from whatever is current. */
  const apply = (next: PermissionMode): void => {
    setBusy(true)
    void (async () => {
      const applied = await writePermissionMode(sessionId, next)
      // Only adopt what the server confirms; a failed write leaves the button
      // showing the mode that is still in effect.
      if (applied !== undefined) setMode(applied)
      setBusy(false)
    })()
  }

  const toggle = (): void => {
    if (busy) return
    const outcome = toggleOutcome(mode)
    if (outcome === 'none') return
    if (outcome === 'confirm') {
      // Escalation: ask first. The dialog's confirm button is what writes.
      setConfirmation({ acknowledged: false, setAcknowledged: (acknowledged) => {
        setConfirmation((current) => current === undefined ? current : { ...current, acknowledged })
      } })
      return
    }
    // De-escalation gives up access; nothing to warn about.
    apply('read_only')
  }

  const cancelConfirmation = (): void => { setConfirmation(undefined) }

  const confirmToggle = (): void => {
    if (confirmation === undefined || !mayApply(confirmation.acknowledged)) return
    setConfirmation(undefined)
    apply('read_write')
  }

  const reread = (): void => { setReadGeneration(generation => generation + 1) }

  return { mode, busy, toggle, confirmation, cancelConfirmation, confirmToggle, reread }
}