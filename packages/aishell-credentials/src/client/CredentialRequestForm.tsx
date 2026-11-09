/**
 * The credential card — the one surface where credentials are entered.
 *
 * Rendered into `conversation.composer`, taking over the input box the way the
 * approval panel does. A credential chip opens it, and `aishell__auth` asks for
 * it when a tool call has no usable credential.
 *
 * ## Two states, decided by whether a credential is stored
 *
 * The card shows **one** of two things, and nothing else:
 *
 *   - **Signed in** — the account name, a way to accept it, and a way out. No
 *     inputs, because the question a signed-in person has is "who am I, and am
 *     I done", not "what is your access key". `确认` answers a waiting
 *     `aishell__auth`; `退出` clears the credential.
 *   - **Not signed in** — both ways to obtain a credential, side by side.
 *
 * One panel with a button that reports its own state, rather than a page per
 * step. The person sees one card either way, so separate pages would be the
 * same layout repeated — and the transitions between them would be visible:
 * fields appearing and being replaced a moment later as the probe answered.
 *
 * ## Why the browser route reports itself in place
 *
 * The button is the status: `checking` while the probe runs, `login` once it
 * passes, `unsupported` when it fails, `cancel` while a login is in flight with
 * the countdown beside it. A separate "waiting" page would be a second layout
 * to keep in step with this one, for no gain.
 *
 * @module @huaweidevtools/aishell-dsh-client-credentials/client/CredentialRequestForm
 */

import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
// Type-only: pulls the Conversation slot contracts this component's props are
// typed against.
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
// Type-only: merges this domain's interaction into SessionPendingInteractionMap,
// so the chain's owner props type the pending interaction back to us.
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import type { InjectFace, PropsRuntime, PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { SnapshotStore } from '@deepseek-ai/dsh-client-store'
// Type-only: merges the `aishell` key into LocaleNamespaceMap.
import type {} from './locales.ts'
import { CREDENTIAL_URL, type CredentialStatus, type SaveVerdict } from './credential-status.ts'
import type { BrowserLoginHandle } from './login-flow.ts'
import { openLoginWindow } from './login-flow.ts'
import { decodeOutcome } from '../login-status.ts'
import { browserButton, formatCountdown, type BrowserButtonState, type LoginPhase } from './card-state.ts'
import {
  DIAL_CLASS,
  DIAL_DOT_CLASS,
  DIAL_DOT_COUNT,
  DIAL_LABEL_CLASS,
  DIAL_RING_CLASS,
  PROGRESS_CLASS,
  PROGRESS_TRACK_CLASS,
} from './form-motion.ts'
import type { CredentialPrefill } from '../prefill.ts'
import type { CredentialFormInteraction } from './CredentialFormInteraction.ts'

// Publish the interaction's own type into the session-status union the
// composer chain's owner props carry: `pendingInteraction` reaches this
// component type-erased unless the interaction's shape is declared here.
declare module '@deepseek-ai/dsh-client-ui-session/client' {
  interface SessionPendingInteractionMap {
    'aishell-credential-form': CredentialFormInteraction
  }
}

/** Injected handle bound in apply(). */
export interface CredentialRequestFormInjected {
  hooks: {
    /** Credential presence + account hint, rebound by the renderer as useCredentials. */
    credentials: SnapshotStore<CredentialStatus>
    /** The last browser login's outcome, rebound as useLoginOutcome. */
    loginOutcome: SnapshotStore<string>
  }
  /** Store AK/SK/SecurityToken through the Host credential route. */
  save: (accessKeyId: string, secretAccessKey: string, securityToken?: string) => Promise<SaveVerdict>
  /**
   * Ask whether a browser here can reach a loopback listener.
   *
   * Called on open, so the button can report whether the route exists here
   * before anyone presses it.
   *
   * @param signal - aborts the request when the card goes away.
   * @returns whether the browser route works from where this page is loaded.
   */
  probeBrowserRoute: (signal?: AbortSignal) => Promise<boolean>
  /**
   * Begin a browser login. Called when the person asks for one, not before.
   *
   * Binds its own listener and fetches a URL projected for it at that moment,
   * so the URL is fresh however long the card sat open.
   *
   * @returns a handle for the login in flight, or `undefined` on failure.
   */
  startBrowserLogin: () => Promise<BrowserLoginHandle | undefined>
  /**
   * Values the host already has, to start the fields with.
   *
   * Fills the inputs; it does not submit, does not hide the card, and every
   * field stays editable. The point is to save the person copying three values
   * out of their shell — not to skip the form.
   */
  readPrefill: () => Promise<CredentialPrefill>
  /** Clear the stored credentials. */
  clear: () => Promise<SaveVerdict>
  /** Withdraw the card after saving — restores the ordinary composer. */
  close: () => void
  /**
   * Accept the stored credentials and withdraw the card.
   *
   * The signed-in card's affirmative action: the person looked at the account
   * and is done. Distinct from {@link close} because it also answers a waiting
   * `aishell__auth` — without it, a blocked call could only be answered by
   * logging out, which destroys the credential it was waiting to use.
   *
   * Writes nothing and verifies nothing; the caller re-reads the store.
   */
  confirm: () => void
  /**
   * Decline: withdraw the card and tell the host this request was refused.
   *
   * The difference matters. Without it the host cannot tell "the person said
   * no" from "the person has not answered", and a model whose call failed has
   * every reason to ask again until the turn ends.
   */
  cancel: () => void
}

/** Full component props: composer owner share + locale seat + inject face. */
export type CredentialRequestFormProps =
  & PropsRuntime<'conversation.composer'>
  & PropsLocale<'aishell'>
  & InjectFace<CredentialRequestFormInjected>

/**
 * The credential card.
 *
 * Submitting saves through the Host route; the card then closes itself, and the
 * chip flipping to the account name is the feedback that it worked.
 */
export function CredentialRequestForm(props: CredentialRequestFormProps): ReactNode {
  const t = props.t
  const { save, clear, close, cancel, confirm } = props
  const status = props.useCredentials(snapshot => snapshot)
  const [ak, setAk] = useState('')
  const [sk, setSk] = useState('')
  const [token, setToken] = useState('')
  const [saving, setSaving] = useState(false)
  const [clearing, setClearing] = useState(false)
  /** A failure of whichever route produced it; each section renders its own. */
  const [browserError, setBrowserError] = useState<string | undefined>(undefined)
  const [manualError, setManualError] = useState<string | undefined>(undefined)
  /** Whether the fields were seeded from the environment, so the notice is honest. */
  const [prefilled, setPrefilled] = useState(false)

  const [login, setLogin] = useState<BrowserLoginHandle | null | undefined>(undefined)
  const [phase, setPhase] = useState<LoginPhase>('checking')
  const [secondsLeft, setSecondsLeft] = useState<number | undefined>(undefined)
  /**
   * The window this login started with, held so the progress line can compute
   * its fraction. `secondsLeft` alone cannot: a fraction needs the denominator,
   * and reading it back off the handle would give a value that changes when a
   * later login replaces it — while an earlier one's line is still on screen.
   */
  const [loginWindowSeconds, setLoginWindowSeconds] = useState<number | undefined>(undefined)

  /**
   * Whether a credential is stored, read live rather than captured.
   *
   * Live because the card changes state under the person's hands: a successful
   * save or login moves it to the signed-in view without a reopen, and a clear
   * moves it back.
   */
  const signedIn = status.hasAccessKey || status.hasSecretKey

  // Seed the fields once, on open. The form re-renders as the person types, so
  // a re-run would overwrite their edits.
  useEffect(() => {
    let live = true
    void props.readPrefill().then((prefill) => {
      const { accessKeyId, secretAccessKey } = prefill
      if (!live || accessKeyId === undefined || secretAccessKey === undefined) return
      // Only fills what is still empty, so a fast typist is never overwritten.
      setAk((current) => current === '' ? accessKeyId : current)
      setSk((current) => current === '' ? secretAccessKey : current)
      setToken((current) => current === '' ? (prefill.securityToken ?? '') : current)
      setPrefilled(true)
    }).catch(() => { /* no prefill is the ordinary case */ })
    return () => { live = false }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Ask whether the browser route works here, once per open. This binds no
  // lasting resource: the host borrows a port, this page fetches it, and the
  // port goes back. Nothing is kept for a login that may never be asked for.
  useEffect(() => {
    const controller = new AbortController()
    void props.probeBrowserRoute(controller.signal).then((reachable) => {
      if (controller.signal.aborted) return
      setPhase(reachable ? 'ready' : 'unsupported')
    }).catch(() => {
      if (!controller.signal.aborted) setPhase('unsupported')
    })
    // Aborting stops a loopback request whose answer nobody is waiting for any
    // more. The host's port is not released by this — it never learns the card
    // went away — but its own window closes the port regardless.
    return () => { controller.abort() }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  /**
   * Whether this card is still on screen.
   *
   * A start that is in flight when the card closes must not be forgotten: the
   * host binds its listener before it answers, so a request whose reply nobody
   * reads leaves a port bound until the login's own deadline — ten minutes —
   * expires. Read after the await, alongside the handle it carried.
   *
   * Re-armed in the effect body, not just set once. This effect is keyed on the
   * handle, so it re-runs when a login starts or is cancelled; a flag only ever
   * lowered in the cleanup would stay `false` after that re-run, and the next
   * login would close its own tab and release its port on the spot.
   */
  const mounted = useRef(true)

  // Release the host's listener whenever the card goes away without the login
  // being used. Without this a closed card leaves a port bound.
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
      login?.cancel()
    }
  }, [login])

  // Count down to the moment the callback stops being possible, from the
  // service's own `expires_in` — so the number on screen and the deadline the
  // listener enforces agree. Ticks on a wall-clock difference rather than by
  // decrementing, so a throttled background tab does not drift.
  useEffect(() => {
    // A running login with no countdown has nothing to count: the host reports
    // a window, and a client that did not receive one must not invent a
    // deadline of zero — that would expire the login on its first tick.
    if (phase !== 'running' || secondsLeft === undefined) return
    const deadline = Date.now() + secondsLeft * 1000
    const timer = window.setInterval(() => {
      const left = Math.max(0, Math.round((deadline - Date.now()) / 1000))
      setSecondsLeft(left)
      if (left === 0) {
        // The window closed: the callback can no longer arrive. The listener
        // has already closed itself, so this only has to say so.
        window.clearInterval(timer)
        setPhase('ready')
        setBrowserError(t('form.browser.expired'))
      }
    }, 1000)
    return () => { window.clearInterval(timer) }
    // Seeded when the wait begins; the tick recomputes from the deadline, so
    // re-running on each change would restart the clock.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase])

  // Drop the countdown when a login ends, so a later attempt starts fresh.
  useEffect(() => {
    if (phase !== 'running') {
      setSecondsLeft(undefined)
      setLoginWindowSeconds(undefined)
    }
  }, [phase])

  // The login's outcome, written by the host when the credential lands. Read
  // from the document rather than awaited: the person may be at the cloud for
  // minutes, so there is no request to hold.
  const outcomeRaw = props.useLoginOutcome(snapshot => snapshot)

  /**
   * The outcome already recorded when this card opened.
   *
   * The document keeps the last login's outcome, so a card opened later would
   * otherwise react to a result that has nothing to do with it: after a success
   * the next open would close itself on the spot, and after a failure it would
   * show that error before the person did anything.
   */
  const outcomeAtMount = useRef<string | null>(null)
  if (outcomeAtMount.current === null) outcomeAtMount.current = outcomeRaw

  useEffect(() => {
    if (outcomeRaw === outcomeAtMount.current) return
    const outcome = decodeOutcome(outcomeRaw)
    if (outcome === undefined) return
    if (outcome.kind === 'succeeded') {
      // The store holds a verified credential, so the card's job is done. The
      // signed-in view is what the next open shows.
      setAk(''); setSk(''); setToken('')
      close()
      return
    }
    // Failed. Back to a usable button, with the reason in the browser section —
    // the inputs were only disabled for the duration of the attempt.
    setPhase('ready')
    setBrowserError(outcome.error === '' ? t('form.browser.failed') : outcome.error)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [outcomeRaw])

  /**
   * Start a sign-in, because the person asked for one.
   *
   * The URL is fetched now rather than when the card opened: it names the port
   * this login binds, and the service only promises it for a window. A card
   * that sat open for a while still offers a URL that works, which is the whole
   * reason probe and start are separate.
   */
  const onBrowserLogin = async (): Promise<void> => {
    if (phase === 'running' || phase === 'starting') return
    setBrowserError(undefined)

    // The tab is opened before anything is awaited, because a browser only
    // allows a popup while the user gesture is live and the gesture does not
    // survive an `await`. The login URL cannot exist yet — the host has not
    // bound the port it names — so the tab is opened blank and pointed at it a
    // moment later. Fetching the URL first is what a blocker would refuse.
    //
    // `undefined` here is a refused popup, and it is NOT an error. The running
    // state always offers 「点击此处打开」, which is a real link: following it is
    // the person's own navigation, so a blocker has no say in it. Telling
    // someone to go change a browser setting when the card already carries a
    // link that works is a dead end, and a worse one than saying nothing.
    const tab = openLoginWindow()
    if (tab === undefined) {
      // A refused popup is not an error — the running state carries a working
      // link — but it is not nothing either, and staying silent about it is
      // what made this look like the button was dead. Recorded so a person can
      // tell "the tab was refused" from "the login failed", and so the reason
      // reaches a console when one is watching.
      console.warn(
        '[aishell-credentials] window.open returned null for the sign-in tab. '
        + 'The login continues; the link on the card is the way in.',
      )
    }

    setPhase('starting')
    const handle = await props.startBrowserLogin()
    if (!mounted.current) {
      // The card closed while the host was binding. The handle is the only
      // thing that can release that port, and nothing else holds a reference.
      tab?.close()
      handle?.cancel()
      return
    }
    if (handle === undefined) {
      // The host could not bind or reach the service. Close the blank tab so
      // the person is not left with one, and return to a pressable button.
      tab?.close()
      setPhase('ready')
      setBrowserError(t('form.browser.startFailed'))
      return
    }
    tab?.navigate(handle.loginUrl)
    setLogin(handle)
    setPhase('running')
    // A service that reports no window leaves both unset: there is nothing to
    // count and no fraction to draw, and inventing either would put a number on
    // screen the listener does not honour.
    const window = handle.expiresInSeconds > 0 ? handle.expiresInSeconds : undefined
    setSecondsLeft(window)
    setLoginWindowSeconds(window)
  }

  /**
   * Abandon the login in flight.
   *
   * Releases the host's listener — the URL on screen is dead from this moment —
   * and returns the button, so the person can try again or fall back to pasting
   * a key. Not a refusal of the card itself: `取消` does that, and it is a
   * separate button below.
   */
  const onCancelLogin = useCallback((): void => {
    login?.cancel()
    setLogin(undefined)
    setPhase('ready')
    setBrowserError(undefined)
  }, [login])

  const onSubmit = async (event: { preventDefault: () => void }): Promise<void> => {
    event.preventDefault()
    setSaving(true)
    setManualError(undefined)
    try {
      const verdict = await save(ak, sk, token === '' ? undefined : token)
      if (!verdict.ok) {
        setManualError(verdict.error ?? t('form.failed'))
        return
      }
      // Saved. Clearing the fields keeps a rejected secret out of the DOM for
      // the moment between the Host's answer and this card unmounting.
      setAk(''); setSk(''); setToken('')
      close()
    } catch (err) {
      setManualError(err instanceof Error ? err.message : String(err))
    } finally {
      setSaving(false)
    }
  }

  const onClear = async (): Promise<void> => {
    setClearing(true)
    setManualError(undefined)
    try {
      const verdict = await clear()
      // A successful clear flips the card to the signed-out view on its own:
      // `signedIn` reads the status, which the route has just rewritten. That
      // is where both routes are offered again.
      if (!verdict.ok) setManualError(verdict.error ?? t('form.clear.failed'))
    } catch (err) {
      setManualError(err instanceof Error ? err.message : String(err))
    } finally {
      setClearing(false)
    }
  }

  const onCancel = (): void => {
    // The card is going away, so the host's login listener has no one left to
    // serve. The unmount effect covers this too, but releasing here frees the
    // port before the host is told the request was declined.
    login?.cancel()
    cancel()
  }

  // ── Styles ────────────────────────────────────────────────────────────────

  const fieldStyle: React.CSSProperties = { display: 'flex', flexDirection: 'column', gap: 6 }
  const labelStyle: React.CSSProperties = {
    fontSize: 11,
    lineHeight: '16px',
    fontWeight: 500,
    letterSpacing: '0.04em',
    textTransform: 'uppercase',
    color: 'var(--dsw-alias-label-tertiary)',
  }
  const inputStyle = (disabled: boolean): React.CSSProperties => ({
    boxSizing: 'border-box',
    width: '100%',
    height: 34,
    padding: '0 10px',
    border: '0.5px solid var(--dsw-alias-border-l4)',
    borderRadius: 8,
    font: 'inherit',
    fontSize: 14,
    lineHeight: '22px',
    background: 'var(--dsw-alias-bg-layer-1)',
    color: 'var(--dsw-alias-label-primary)',
    opacity: disabled ? 0.5 : 1,
    cursor: disabled ? 'not-allowed' : 'text',
  })
  const buttonStyle = (disabled: boolean, kind: 'primary' | 'secondary' | 'quiet' = 'secondary'):
  React.CSSProperties => ({
    // Fills its share of the row rather than sizing to its label. Every button
    // on this card sits in a row of one or two, so this makes the rows line up
    // on the same left and right edges — and it stops the width changing when
    // a label does (`登录` → `取消登录`), which read as the control moving
    // under the pointer.
    flex: 1,
    height: 34,
    padding: '0 16px',
    borderRadius: 8,
    font: 'inherit',
    fontSize: 14,
    cursor: disabled ? 'default' : 'pointer',
    opacity: disabled ? 0.45 : 1,
    border: kind === 'primary' ? 'none' : '0.5px solid var(--dsw-alias-border-l4)',
    background: kind === 'primary'
      ? 'var(--dsw-alias-button-primary-fill)'
      : kind === 'quiet' ? 'transparent' : 'var(--dsw-alias-bg-layer-1)',
    color: kind === 'primary'
      ? 'var(--dsw-alias-label-primary-foreground)'
      : 'var(--dsw-alias-label-primary)',
  })
  const divider = (text: string): ReactNode => (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
      <span style={{ flex: 1, height: 1, background: 'var(--dsw-alias-border-l4)' }} />
      <span style={{ fontSize: 12, color: 'var(--dsw-alias-label-tertiary)' }}>{text}</span>
      <span style={{ flex: 1, height: 1, background: 'var(--dsw-alias-border-l4)' }} />
    </div>
  )
  const notice: React.CSSProperties = {
    margin: 0,
    fontSize: 12,
    lineHeight: '18px',
    color: 'var(--dsw-alias-state-warn-label)',
  }

  const busy = saving || clearing
  /** While a login runs, the other route is disabled — both write one record. */
  const manualDisabled = busy || phase === 'running'
  const submitDisabled = manualDisabled || !ak || !sk
  const button: BrowserButtonState = browserButton(phase, secondsLeft !== undefined)

  return (
    <div
      role="group"
      aria-label={t('form.title')}
      style={{
        padding: '6px calc(var(--dsh-composer-side-clearance) + 16px) 10px',
        display: 'flex',
        justifyContent: 'center',
      }}
    >
      <form
        onSubmit={onSubmit}
        style={{
          width: '100%',
          maxWidth: 'var(--dsh-chat-content-width)',
          background: 'var(--dsw-specific-input-major)',
          boxShadow: 'var(--dsw-elevation-panel)',
          border: '0.5px solid var(--dsw-alias-border-l2-darkmode-thin)',
          borderRadius: 20,
          padding: '16px 20px',
          display: 'flex',
          flexDirection: 'column',
          gap: 14,
        }}
      >
        <span style={{ fontSize: 14, fontWeight: 600, lineHeight: '22px' }}>
          {t('form.title')}
        </span>

        {signedIn ? (
          /* ── Signed in ──────────────────────────────────────────────────
             What is stored, and the one action that matters: leaving. The
             inputs are absent because someone with a credential is not being
             asked for one. */
          <>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span
                aria-hidden
                style={{
                  width: 8,
                  height: 8,
                  borderRadius: '50%',
                  background: 'var(--dsw-alias-state-success-primary)',
                  flex: 'none',
                }}
              />
              <span style={{ fontSize: 14, lineHeight: '22px' }}>
                {status.accessKeyIdHint === '' ? t('form.signedIn') : status.accessKeyIdHint}
              </span>
            </div>
            <div style={{ display: 'flex', gap: 12 }}>
              <button type="button" onClick={confirm} disabled={busy}
                style={buttonStyle(busy, 'primary')}>
                {t('form.confirm')}
              </button>
              <button type="button" onClick={() => { void onClear() }} disabled={busy}
                style={buttonStyle(busy)}>
                {clearing ? t('form.clearing') : t('form.logout')}
              </button>
            </div>
            {manualError !== undefined && <p style={notice}>{manualError}</p>}
          </>
        ) : (
          /* ── Signed out ─────────────────────────────────────────────────
             Both routes, side by side. */
          <>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {/* The section heading, shown in every state EXCEPT a login in
                  flight — there the dial and its countdown take this slot, and
                  the heading would sit above them saying nothing new. One
                  conditional span rather than a static heading plus a second
                  one for the other branch: two spans rendering the same key is
                  how this appeared twice at once. */}

              {/* A ring of dots that grows from faint to solid as it sweeps,
                  with the label held still in the middle and the countdown
                  centred beneath it. The dots are sized and faded from
                  `--i` in CSS, so the count here is the only place the
                  ring's length is decided. */}
              {phase === 'running' && (
                <>
                  {/* A ring of dots that grows from faint to solid as it sweeps,
                      with the label held still in the middle and the countdown
                      centred beneath it. The dots are sized and faded from
                      `--i` in CSS, so the count here is the only place the
                      ring's length is decided. */}
                  <div className={DIAL_CLASS}>
                    <div className={DIAL_RING_CLASS} aria-hidden>
                      {Array.from({ length: DIAL_DOT_COUNT }, (_, i) => (
                        <span
                          key={i}
                          className={DIAL_DOT_CLASS}
                          style={{ '--i': i } as React.CSSProperties}
                        />
                      ))}
                    </div>
                    <span className={DIAL_LABEL_CLASS}>{t('form.browser.runningLabel')}</span>
                  </div>
                  <span
                    role="status"
                    style={{
                      fontSize: 13,
                      lineHeight: '20px',
                      textAlign: 'center',
                      // The digits change once a second, and in a proportional
                      // face `1` is narrower than `8` — so the whole line would
                      // twitch on every tick. Tabular figures give each digit
                      // the same width, which is what `formatCountdown`'s note
                      // means by applying them at the call site.
                      fontVariantNumeric: 'tabular-nums',
                      color: 'var(--dsw-alias-label-tertiary)',
                    }}
                  >
                    {secondsLeft === undefined ? '' : formatCountdown(secondsLeft)}
                  </span>
                  {/* A line that drains as the window closes. Its width comes
                      from the countdown rather than a CSS animation, so it can
                      never disagree with the number above it. Omitted without a
                      countdown: a bar that cannot know its fraction would be a
                      decoration pretending to be information. */}
                  {secondsLeft !== undefined && loginWindowSeconds !== undefined && (
                    <span className={PROGRESS_TRACK_CLASS} aria-hidden>
                      <span
                        className={PROGRESS_CLASS}
                        style={{
                          width: `${String(Math.round((secondsLeft / loginWindowSeconds) * 100))}%`,
                        }}
                      />
                    </span>
                  )}
                </>
              )}
              {phase !== 'running' && (
                <span style={{ fontSize: 13, fontWeight: 500, color: 'var(--dsw-alias-label-secondary)' }}>
                  {t('form.browser.section')}
                </span>
              )}
              {phase === 'checking' && (
                <span style={{ fontSize: 12, lineHeight: '18px', color: 'var(--dsw-alias-label-tertiary)' }}>
                  {t('form.browser.checking')}
                </span>
              )}
              {phase === 'unsupported' && (
                <span role="status" style={notice}>{t('form.browser.unsupported')}</span>
              )}

              {/* One button alone in the row, and it fills the row — the same
                  edges the AK/SK pair below it spans, so the card reads as a
                  stack of full-width controls rather than a ragged column. */}
              <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                <button
                  type="button"
                  onClick={phase === 'running' ? onCancelLogin : onBrowserLogin}
                  disabled={button.disabled}
                  style={buttonStyle(button.disabled, button.disabled ? 'secondary' : 'primary')}
                >
                  {t(button.label)}
                </button>
              </div>

              {phase === 'running' && login !== null && login !== undefined && (
                <span style={{ fontSize: 12, lineHeight: '18px', color: 'var(--dsw-alias-label-tertiary)' }}>
                  {/* No `{' '}` around the anchor. The space between a word and
                      a following link is `none` in Chinese and `one` in
                      English, so it lives at the ends of the dictionary
                      strings rather than in the markup — a space written here
                      would show as a gap before the Chinese full stop. */}
                  {t('form.browser.notOpened')}
                  {/* A real anchor, not a button dressed as a link. Following a
                      link is the person's own navigation, so a popup blocker
                      does not stand in its way — whereas `window.open` from a
                      handler, which is what the copy fallback existed to work
                      around, is exactly what a blocker refuses. `noopener` so
                      the sign-in page gets no handle back to this one. */}
                  <a
                    href={login.loginUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    style={{
                      color: 'var(--dsw-alias-button-primary-fill)',
                      textDecoration: 'underline',
                    }}
                  >
                    {t('form.browser.openHere')}
                  </a>
                  {t('form.browser.openHereSuffix')}
                </span>
              )}

              {browserError !== undefined && <p style={notice}>{browserError}</p>}
            </div>

            {divider(t('form.or'))}

            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              <span style={{ fontSize: 13, fontWeight: 500, color: 'var(--dsw-alias-label-secondary)' }}>
                {t('form.manual.section')}
              </span>
              {prefilled && <p style={notice}>{t('form.prefilledFromEnv')}</p>}
              <span style={{ fontSize: 12, lineHeight: '18px', color: 'var(--dsw-alias-label-tertiary)' }}>
                {t('section.credentials.hint.prefix')}{' '}
                <a
                  href={CREDENTIAL_URL}
                  target="_blank"
                  rel="noreferrer noopener"
                  style={{ color: 'var(--dsw-alias-button-primary-fill)', textDecoration: 'underline' }}
                >
                  {t('section.credentials.hint.link')}
                </a>{' '}
                {t('section.credentials.hint.suffix')}
              </span>

              <div style={fieldStyle}>
                <span style={labelStyle}>{t('section.field.accessKey')}</span>
                <input type="password" value={ak} disabled={manualDisabled}
                  onChange={e => setAk(e.target.value)}
                  style={inputStyle(manualDisabled)}
                  placeholder={t('section.field.accessKey.placeholder')}
                  aria-label={t('section.field.accessKey')} autoComplete="off" autoFocus />
              </div>
              <div style={fieldStyle}>
                <span style={labelStyle}>{t('section.field.secretKey')}</span>
                <input type="password" value={sk} disabled={manualDisabled}
                  onChange={e => setSk(e.target.value)}
                  style={inputStyle(manualDisabled)}
                  placeholder={t('section.field.secretKey.placeholder')}
                  aria-label={t('section.field.secretKey')} autoComplete="off" />
              </div>
              <div style={fieldStyle}>
                <span style={labelStyle}>{t('section.field.token')}</span>
                <input type="password" value={token} disabled={manualDisabled}
                  onChange={e => setToken(e.target.value)}
                  style={inputStyle(manualDisabled)}
                  placeholder={t('section.field.token.placeholder')}
                  aria-label={t('section.field.token')} autoComplete="off" />
              </div>

              {manualError !== undefined && <p style={notice}>{manualError}</p>}

              <div style={{ display: 'flex', gap: 12 }}>
                <button type="submit" disabled={submitDisabled}
                  style={buttonStyle(submitDisabled, 'primary')}>
                  {saving ? t('section.credentials.saving') : t('form.submit')}
                </button>
                <button type="button" onClick={onCancel} disabled={busy} style={buttonStyle(busy)}>
                  {t('form.dismiss')}
                </button>
              </div>
            </div>
          </>
        )}
      </form>
    </div>
  )
}
