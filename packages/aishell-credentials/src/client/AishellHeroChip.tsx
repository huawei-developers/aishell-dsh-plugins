/**
 * Compact account + permission chip for the New-Session hero.
 *
 * The composer chip lives under the input bar, which DSH does not render until
 * a session exists — its slot is guarded by `variant === "composer" && input
 * !== undefined && sessionId !== undefined`. A New Session therefore showed
 * neither the account nor the permission mode, which are exactly the two facts
 * worth checking before sending the first message.
 *
 * This renders into `conversation.input.dock`, the band between the hero
 * workspace row and the input card. That band is a `list` slot, chosen over
 * the hero row's `single` seats precisely because both of those are held by
 * official occupants on 0.2.1-alpha.1 — ui-workspace's WorkspacePicker in
 * `conversation.hero.workspace` (shadowing it by `priority: -1` is what
 * silently killed the workspace menu) and ui-agent-preset's seat in
 * `conversation.hero.agentPreset`. A `list` entry composes beside the others
 * (the TodoPanel precedent) instead of competing for a seat, so it cannot
 * collide with an occupant however the base evolves.
 *
 * The dock band renders in BOTH the hero and the session composer (it only
 * needs a live input zone), while the composer-dock chip covers the session
 * posture — so this entry gates itself on `session.blank` and renders nothing
 * once a conversation exists, keeping exactly one chip on screen at a time.
 *
 * ## Relationship to the composer chip
 *
 * Both chips report the same two facts — which account the session is signed
 * as, and whether mutations are allowed — and a person should not have to
 * learn two shapes. They carry the same mark, the same colour pair, and the
 * same two affordances (open the credential form, toggle the mode); they
 * differ only in the
 * width each surface affords, which is why this chip clamps the
 * account name with `maxWidth` instead of letting it run to the row's edge.
 *
 * @module @huaweidevtools/aishell-dsh-client-credentials/client/AishellHeroChip
 */

import { type ReactNode, useLayoutEffect, useRef, useState } from 'react'
// Type-only: pulls the Conversation slot contracts this component's props are
// typed against.
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { InjectFace, PropsRuntime, PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
// Type-only: merges the `aishell` key into LocaleNamespaceMap.
import type {} from './locales.ts'
import type { CredentialStatus } from './credential-status.ts'
import type { SnapshotStore } from '@deepseek-ai/dsh-client-store'
import { usePermissionMode } from './permission-mode.ts'
import { PermissionRiskDialog } from './PermissionRiskDialog.tsx'
import { CHIP_CLASS, HUAWEI_LOGO_PATH, HUAWEI_RED } from './huawei-mark.ts'
import type { OpenCredentialFormCallback } from './AishellAccountHint.tsx'

/** Injected handle bound in apply(). */
export interface AishellHeroChipInjected {
  hooks: {
    /** Credential presence + account hint, rebound by the renderer as useCredentials. */
    credentials: SnapshotStore<CredentialStatus>
  }
  /** Opens the credential form in this conversation (no-op if already up). */
  openCredentialForm: OpenCredentialFormCallback
}

/** Full component props: slot owner share + locale seat + inject face. */
export type AishellHeroChipProps =
  & PropsRuntime<'conversation.input.dock'>
  & PropsLocale<'aishell'>
  & InjectFace<AishellHeroChipInjected>

export function AishellHeroChip(props: AishellHeroChipProps): ReactNode {
  // Every hook runs on every render, BEFORE the blank early-return below:
  // `blank` flips to false when the first turn is accepted, and a render that
  // skips hooks React already counted (React error #300) would crash the
  // whole dock band — the crash the first end-to-end run caught.
  const blank = props.useSession(session => session.blank)
  const status = props.useCredentials(snapshot => snapshot)
  const { mode, busy, toggle, confirmation, cancelConfirmation, confirmToggle } = usePermissionMode()
  const t = props.t
  // Bound in apply: opens the credential form in this conversation.
  const openCredentialForm = props.openCredentialForm
  const configured = Boolean(status.accessKeyIdHint)

  // Placement against the official hero row. The slot seat this chip owns
  // (conversation.input.dock) renders inside the composer STACK, a column
  // whose children are: hero chrome, the workspace row, this band, the input
  // card — the row's own DOM is a sibling subtree no CSS of ours can join.
  // The pre-0.2.1 posture this chip restores (verified against the shipped
  // alpha.8: buttons pack from the left, pill right after the agent-preset
  // control) takes two moves: a negative top margin lifts the pill from its
  // band onto the row's line (the value couples to the row's 28px height +
  // the stack's 8px row gap, minus 3px to center this 22px pill in the 28px
  // row), and a measured left offset packs it after the preset control.
  //
  // Each measurement law below is earned by a defect it caused:
  // - The offset's base is the STACK's left edge, never this wrapper's own
  //   rect: the wrapper moves with the very margin being set, so a
  //   self-based re-measure (the 500ms sweep runs on every New Session)
  //   collapses the offset to 0 and the chip jumps once per session.
  // - The observer watches the ROW's buttons (workspace chip, preset
  //   control), not this wrapper's parent: that parent is the display:
  //   contents slot anchor, whose rect is degenerate, so nothing it saw ever
  //   resized — a locale switch or a longer mode name moved the packing
  //   point and the chip slid under the official control.
  // - A seat with no entry renders a boxless anchor whose rect is all
  //   zeroes; that reads as a huge negative offset. Non-positive offsets —
  //   empty seat, pre-layout — fall back to the band: no lift, no shift.
  //   Degraded placement, never out of view, never over an official control.
  // - The effect re-runs on `blank`: the wrapper's DOM node is replaced each
  //   time the hero re-appears (blank false → true) while this component
  //   instance persists, so a node captured at first mount goes stale from
  //   the second New Session on. measure() reads the ref fresh, and the
  //   observer re-attaches to the new row nodes.
  const wrapperRef = useRef<HTMLDivElement | null>(null)
  const [presetOffset, setPresetOffset] = useState<number | null>(null)
  // Mirror of presetOffset the sweep reads synchronously: setState is async,
  // so a sweep immediately after measure() would read a stale state and
  // schedule itself forever even though the offset just landed.
  const presetOffsetRef = useRef<number | null>(null)
  const applyOffset = (offset: number | null): void => {
    presetOffsetRef.current = offset
    setPresetOffset(offset)
  }
  useLayoutEffect(() => {
    let observer: ResizeObserver | undefined
    let observedRow: Element | undefined
    const measure = (): void => {
      // Fresh ref read on every call — the law on `blank` above.
      const wrapper = wrapperRef.current
      if (wrapper === null) return
      let stack = wrapper.parentElement
      while (stack !== null && getComputedStyle(stack).display === 'contents') stack = stack.parentElement
      // The preset control itself, never the seat anchor: the anchor is
      // display:contents, so its own rect is degenerate — a seat with no
      // entry must read as absent, not as a zero-rect control.
      const preset = stack?.querySelector<HTMLElement>('[data-slot="conversation.hero.agentPreset"] > *') ?? null
      if (stack === null || preset === null) { applyOffset(null); return }
      // Idempotent base: the stack's edge never moves with this chip's own
      // margin, so every re-measure reproduces the same offset.
      const offset = Math.round(preset.getBoundingClientRect().right - stack.getBoundingClientRect().left + 6)
      if (!(offset > 0)) { applyOffset(null); return }
      applyOffset(offset)
      // (Re)attach only when the row's identity changed: observe() fires an
      // initial callback per target, so re-observing the same nodes loops.
      const row = preset.closest('[data-slot="conversation.hero.agentPreset"]')?.parentElement ?? null
      if (row === null || row === observedRow) return
      observedRow = row
      observer?.disconnect()
      observer = new ResizeObserver(measure)
      for (const target of row.querySelectorAll('button')) observer.observe(target)
    }
    presetOffsetRef.current = null
    // Sweep until an offset lands: the preset control is a NEW node when its
    // roster loads, and a ResizeObserver only sees nodes it already watches —
    // no resize of the observed buttons announces the arrival. Poll briefly
    // (the wrapper is held off screen meanwhile), capped at 5s; a row that
    // never appears leaves the chip hidden rather than misplaced.
    const SWEEP_CAP_MS = 5000
    const deadline = Date.now() + SWEEP_CAP_MS
    let settled = false
    let sweepTimer = 0
    const sweep = (): void => {
      if (settled) return
      if (presetOffsetRef.current !== null || Date.now() > deadline) { settled = true; return }
      measure()
      if (presetOffsetRef.current !== null) { settled = true; return }
      sweepTimer = window.setTimeout(sweep, 100)
    }
    sweepTimer = window.setTimeout(sweep, 100)
    return () => { settled = true; observer?.disconnect(); window.clearTimeout(sweepTimer) }
  }, [blank])

  // One chip at a time: the composer dock chip (AishellAccountHint) covers the
  // session posture, so this entry renders only while the session is still
  // blank — the New-Session state it exists for. When `blank` flips, the hero
  // layout itself gives way to the docked composer, and the dock entry here
  // renders nothing.
  //
  // Placement must also be settled before the chip is shown: rendering at
  // the fallback offset and jumping once the preset control is measured
  // (its roster loads after mount) is the visible "chip jumps on every New
  // Session" defect. An unsettled measure therefore holds the chip OFF
  // screen (visibility, not unmount — the wrapper must stay in the DOM for
  // the measurement to have a box to read) until an offset lands, which the
  // sweep below settles within ~100ms of the row rendering, capped at 5s.
  if (!blank) return null
  const placed = presetOffset !== null

  // Every control on both chips is a real <button>, which brings the keyboard
  // activation, focus ring and disabled semantics with it. These resets undo
  // the browser's default button chrome once, here, instead of being repeated
  // per element.
  const pillStyle: React.CSSProperties = {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 5,
    flex: 'none',
    padding: '1px 8px',
    font: 'inherit',
    fontSize: 'var(--dsh-content-font-size-secondary, 13px)',
    lineHeight: 'calc(20px + var(--dsh-content-font-delta-secondary, 0px))',
    background: 'transparent',
    border: 'none',
    borderRadius: 24,
    cursor: 'pointer',
    userSelect: 'none',
    whiteSpace: 'nowrap',
  }

  return (
    <div
      ref={wrapperRef}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 2,
        minWidth: 0,
        // Held off screen (not display:none — the box must exist for
        // measurement) until the packing offset is settled; see the
        // placement note above the blank early-return.
        visibility: placed ? 'visible' : 'hidden',
        // See the measurement effect above for the full placement law. The
        // two constants here couple to official values: .heroWorkspaceRow's
        // 28px height and the hero composer stack's 8px row gap (minus 3px to
        // center this 22px pill in the 28px row). A base bump that changes
        // either drifts the pill a few pixels — caught by the dist's layout
        // verification, which measures the pill against the row.
        marginTop: -33,
        marginLeft: presetOffset ?? 0,
        flex: 'none',
      }}
    >
      {/* Mark + account name — click opens the credential form, same
          affordance as the composer chip. */}
      <button
        type="button"
        className={CHIP_CLASS}
        aria-label={configured ? status.accessKeyIdHint : t('account.unconfigured')}
        onClick={openCredentialForm}
        style={{
          ...pillStyle,
          color: configured ? 'var(--dsw-alias-label-tertiary)' : 'var(--dsw-alias-state-warn-label)',
          maxWidth: 220,
          overflow: 'hidden',
          textOverflow: 'ellipsis',
        }}
        title={configured ? status.accessKeyIdHint : t('account.unconfigured')}
      >
        <svg
          aria-hidden
          width="14"
          height="14"
          viewBox="0 0 24 24"
          fill="currentColor"
          style={{
            // Same mark and same colour as the composer chip: brand red once
            // credentials are configured, warning amber before. Nothing here
            // is a status dot — the mark is the brand, and the two chips
            // report the same state the same way.
            color: configured ? HUAWEI_RED : 'var(--dsw-alias-state-warn-label)',
            flex: 'none',
          }}
        >
          <path d={HUAWEI_LOGO_PATH} />
        </svg>
        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>
          {configured ? status.accessKeyIdHint : t('account.unconfigured')}
        </span>
      </button>
      {configured && (
        <button
          type="button"
          onClick={() => { void toggle() }}
          disabled={mode === undefined || busy}
          aria-label={mode === 'read_write' ? t('mode.switchToReadonly') : t('mode.switchToReadwrite')}
          title={
            mode === undefined
              ? t('mode.unavailable.hint')
              : mode === 'read_only'
                ? t('mode.readonly.hint')
                : t('mode.readwrite.hint')
          }
          style={{
            ...pillStyle,
            color: mode === undefined
              ? 'var(--dsw-alias-label-tertiary)'
              : mode === 'read_only'
                ? 'var(--dsw-alias-state-success-primary)'
                : 'var(--dsw-alias-state-warn-label)',
            opacity: mode === undefined || busy ? 0.6 : 1,
            cursor: mode === undefined || busy ? 'default' : 'pointer',
          }}
        >
          {mode === undefined
            ? t('mode.unavailable')
            : mode === 'read_only'
              ? t('mode.readonly')
              : t('mode.readwrite')}
        </button>
      )}
      <PermissionRiskDialog
        confirmation={confirmation}
        onCancel={cancelConfirmation}
        onConfirm={confirmToggle}
        t={t}
      />
    </div>
  )
}