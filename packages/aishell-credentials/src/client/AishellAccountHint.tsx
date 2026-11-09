/**
 * Account hint chip rendered under the composer — shows the account name the
 * Host's IAM verification wrote, so the user can see at a glance which account
 * their chat is signed as.
 *
 * Reads the non-secret `accessKeyIdHint` through the shared `credentials`
 * hooks compartment (a snapshot store the browser half derives from the Host
 * entry's config snapshot) — the full AK never reaches the browser. When no
 * credentials are stored, a muted "未配置凭据" prompt takes the
 * chip's place so the user knows to set up credentials before chatting.
 *
 * Clicking either posture opens the credential form in this conversation —
 * the same surface a blocked tool call brings up.
 *
 * Layout note: the host renders this entry and ContextMeter (the "N turns /
 * N steps" readout) as siblings inside one block-flow dock container. We
 * promote that container to a flex row with `space-between` via a layout
 * effect, so ContextMeter sits left and this chip sits right on the same
 * row — without relying on float (which collapses the container height).
 */

import { useEffect, useRef, type ReactNode } from 'react'
// Type-only: pulls the Conversation slot contracts this component's props are
// typed against.
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { InjectFace, PropsRuntime, PropsLocale, TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
// Type-only: merges the `aishell` key into LocaleNamespaceMap.
import type {} from './locales.ts'
import { usePermissionMode } from './permission-mode.ts'
import { PermissionRiskDialog } from './PermissionRiskDialog.tsx'
import { CHIP_CLASS, HUAWEI_LOGO_PATH, HUAWEI_RED } from './huawei-mark.ts'
import type { CredentialStatus } from './credential-status.ts'
import type { SnapshotStore } from '@deepseek-ai/dsh-client-store'

/** The chip-facing open callback shape (ctx already bound in apply). */
export type OpenCredentialFormCallback = () => void

/** Injected handle bound in apply(). */
export interface AishellAccountHintInjected {
  hooks: {
    /** Credential presence + account hint, rebound by the renderer as useCredentials. */
    credentials: SnapshotStore<CredentialStatus>
  }
  t: TranslateNS<'aishell'>
  /** Opens the credential form in this conversation (no-op if already up). */
  openCredentialForm: OpenCredentialFormCallback
}

/** Full component props: dock owner share + locale seat + inject face. */
export type AishellAccountHintProps =
  & PropsRuntime<'conversation.composer.dock'>
  & PropsLocale<'aishell'>
  & InjectFace<AishellAccountHintInjected>

/**
 * Render the current account hint, or a setup prompt when credentials are
 * absent. The hooks-compartment subscription keeps the chip live: saving
 * credentials in the form publishes a new snapshot through the shared store,
 * and the chip updates in place without a remount — the prompt disappears
 * the moment a hint lands.
 *
 * A layout effect promotes the host dock container (the parent element) to
 * `display:flex; justify-content:space-between` so this chip shares a row
 * with ContextMeter instead of stacking above it. The effect restores the
 * original display on cleanup so it never leaks into other dock entries.
 */
export function AishellAccountHint(props: AishellAccountHintProps): ReactNode {
  const status = props.useCredentials(snapshot => snapshot)
  const hint = status.accessKeyIdHint
  const configured = Boolean(hint)
  const t = props.t
  // Bound in apply: opens the credential form in this conversation.
  const openCredentialForm = props.openCredentialForm
  // Shared with the hero chip so the two surfaces cannot drift apart. The
  // read-write risk gate's state comes back with the mode: both chips drive the
  // same host-side switch, so the confirmation is owned once, here.
  const { mode, busy, toggle, confirmation, cancelConfirmation, confirmToggle } = usePermissionMode()

  // Promote the host dock container to a flex row: chip right, ContextMeter
  // left. The host owns the container's class-based styles; inline `display`
  // wins the cascade, and we restore the prior value on cleanup.
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const host = ref.current?.parentElement
    if (!host) return
    const priorDisplay = host.style.display
    const priorJustify = host.style.justifyContent
    const priorAlign = host.style.alignItems
    host.style.display = 'flex'
    host.style.justifyContent = 'space-between'
    host.style.alignItems = 'center'
    return () => {
      host.style.display = priorDisplay
      host.style.justifyContent = priorJustify
      host.style.alignItems = priorAlign
    }
  }, [])

  // Every control on both chips is a real <button>, which brings the keyboard
  // activation, focus ring and disabled semantics with it. These resets undo
  // the browser's default button chrome once, here, instead of being repeated
  // per element.
  const pillStyle: React.CSSProperties = {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 6,
    flex: 'none',
    padding: '1px 8px',
    font: 'inherit',
    fontSize: 'var(--dsh-content-font-size-secondary, 13px)',
    fontVariantNumeric: 'tabular-nums',
    lineHeight: 'calc(20px + var(--dsh-content-font-delta-secondary, 0px))',
    background: 'transparent',
    border: 'none',
    borderRadius: 24,
    cursor: 'pointer',
    userSelect: 'none',
    whiteSpace: 'nowrap',
  }

  return (
    <div ref={ref} style={{ display: 'inline-flex', alignItems: 'center', gap: 0, marginLeft: 'auto', flex: 'none' }}>
      {/* Mark + account name — click opens the credential form */}
      <button
        type="button"
        className={CHIP_CLASS}
        aria-label={configured ? hint : t('account.unconfigured')}
        onClick={openCredentialForm}
        style={{
          ...pillStyle,
          color: configured
            ? 'var(--dsw-alias-label-tertiary)'
            : 'var(--dsw-alias-state-warn-label)',
          maxWidth: '100%',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
        }}
        title={configured ? hint : t('account.unconfigured')}
      >
        <svg
          aria-hidden
          width="14"
          height="14"
          viewBox="0 0 24 24"
          fill="currentColor"
          style={{
            // Brand red when credentials are configured, warning colour when
            // not — this mark reports whether credentials are set, so it must
            // not borrow the green/amber pair the mode button uses to report
            // severity. Two different questions, two different palettes.
            color: configured ? HUAWEI_RED : 'var(--dsw-alias-state-warn-label)',
            flex: 'none',
          }}
        >
          <path d={HUAWEI_LOGO_PATH} />
        </svg>
        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>
          {configured ? hint : t('account.unconfigured')}
        </span>
      </button>
      {configured && (
        <button
          type="button"
          className={CHIP_CLASS}
          onClick={() => { void toggle() }}
          disabled={mode === undefined || busy}
          // The label names the action, not the current state — the visible
          // text already says which mode is in effect. It also has to stay
          // correct while the mode is unknown: `disabled` removes the button
          // from the tab order, so this string is what a screen reader
          // announces, and "read-only" would be a claim nothing verified.
          aria-label={mode === 'read_write' ? t('mode.switchToReadonly') : t('mode.switchToReadwrite')}
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
          title={
            mode === undefined
              ? t('mode.unavailable.hint')
              : mode === 'read_only'
                ? t('mode.readonly.hint')
                : t('mode.readwrite.hint')
          }
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
