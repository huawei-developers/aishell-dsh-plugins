/**
 * Client half of the permission-mode switch, shared by both chips.
 *
 * The mode lives in the host process (`aishell-deploy`). A Host route reads and
 * writes it; this module owns the fetch and the state hook so the composer chip
 * and the hero chip cannot drift apart.
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
 * Read the current mode from the Host route.
 *
 * @returns the mode, or `undefined` when it could not be read — a broken link
 *          must not be rendered as a working lock, so an unreadable mode is
 *          reported as unknown, never as `read_only`.
 */
export async function readPermissionMode(): Promise<PermissionMode | undefined> {
  try {
    const response = await fetch(PERMISSION_ROUTE)
    const body = await response.json() as { ok?: boolean; mode?: unknown }
    if (body.ok !== true) return undefined
    return asMode(body.mode)
  } catch {
    return undefined
  }
}

/**
 * Write the mode through the Host route.
 *
 * @param mode - the mode to apply.
 * @returns the mode the server reports afterwards, or `undefined` on failure.
 */
export async function writePermissionMode(mode: PermissionMode): Promise<PermissionMode | undefined> {
  try {
    const response = await fetch(PERMISSION_ROUTE, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ mode }),
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
   * No-op while unknown or busy.
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
 * Reads once on mount. The mode is server state that only a person changes, so
 * there is no poll — a second surface flipping it is not a case this handles;
 * each surface re-reads on its own mount.
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
 * @returns the current mode, a busy flag, the gated toggle, and the
 *   confirmation state for a pending read-write flip.
 */
export function usePermissionMode(): PermissionModeControl {
  const [mode, setMode] = useState<PermissionMode | undefined>(undefined)
  const [busy, setBusy] = useState(false)
  const [confirmation, setConfirmation] = useState<PermissionConfirmation | undefined>(undefined)

  useEffect(() => {
    let live = true
    void (async () => {
      const read = await readPermissionMode()
      if (live && read !== undefined) setMode(read)
    })()
    return () => { live = false }
  }, [])

  /** Write the mode the control should land on, from whatever is current. */
  const apply = (next: PermissionMode): void => {
    setBusy(true)
    void (async () => {
      const applied = await writePermissionMode(next)
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

  return { mode, busy, toggle, confirmation, cancelConfirmation, confirmToggle }
}