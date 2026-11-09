/**
 * What the browser-login button says and whether it can be pressed.
 *
 * ## Why this is a module
 *
 * The button is the browser route's whole status display: it reports the probe
 * (`checking`), a refusal (`unsupported`), readiness (`login`), and a login in
 * flight (`cancel`). Four states in one control, decided by two inputs, is
 * exactly the kind of table that reads correctly inline and is wrong at the
 * edges — and this package has no component-rendering test tier, so inline
 * means untested.
 *
 * Split out as a pure function for the same reason
 * `./credential-form-visibility` is: the decision is drivable from a spec.
 *
 * ## The label is a locale key
 *
 * Returned as a key rather than as text so the caller keeps the only `t` — the
 * dictionary is the single place the wording lives, and a function returning
 * English would be a second one.
 *
 * @module @huaweidevtools/aishell-dsh-client-credentials/client/card-state
 */

import type { AishellLocaleKey } from './locales.ts'

/** The button's state: what it says, and whether it does anything. */
export interface BrowserButtonState {
  /** Locale key for the label. */
  readonly label: AishellLocaleKey
  /** Whether the press is refused. */
  readonly disabled: boolean
}

/** Where a browser login has got to. Mirrors the component's `LoginPhase`. */
export type LoginPhase = 'checking' | 'starting' | 'ready' | 'unsupported' | 'running'

/**
 * The button's label and enabled state.
 *
 * @param phase - the probe's answer and whether a login is in flight.
 * @param hasCountdown - whether a countdown is being shown. Unused by the
 *   label, which names the action rather than the remaining time — the
 *   countdown sits above the button where it can be read without the label
 *   changing under the pointer. Kept in the signature so callers pass the same
 *   pair the render does, and so a future state that does depend on it has
 *   somewhere to say so.
 * @returns the label key and whether the button is disabled.
 */
export function browserButton(phase: LoginPhase, hasCountdown: boolean): BrowserButtonState {
  void hasCountdown
  switch (phase) {
    case 'checking':
    case 'starting':
    case 'ready':
      // One label for both. The state is told apart by whether the button can
      // be pressed and by the line above it (`环境检测中…`), so giving the
      // checking state its own verb would report the same fact twice.
      return { label: 'form.browser.action', disabled: phase !== 'ready' }
    case 'unsupported':
      // Same label as the ready state, greying disabled. The sentence above
      // already says the environment does not support this, so a label
      // repeating it would say one thing twice — and it would drop the verb,
      // leaving a grey button that no longer names what it would have done.
      // The disabled state is what reports "not available"; the text stays the
      // name of the action. Shown rather than hidden so the route's existence
      // is not a secret.
      return { label: 'form.browser.action', disabled: true }
    case 'running':
      // The same button becomes the way out, which is why a login in flight
      // needs no separate page.
      return { label: 'form.browser.cancelLabel', disabled: false }
    default:
      return { label: 'form.browser.action', disabled: false }
  }
}

/**
 * Render a countdown as `m:ss`.
 *
 * Language-neutral on purpose: the sentence around it is localised, and a
 * number with a colon needs no translation — spelling out a unit would put a
 * second copy of it in both dictionaries for no gain. Tabular figures are
 * applied at the call site so the digits do not jitter as they change.
 *
 * @param seconds - seconds remaining; negative reads as zero.
 */
export function formatCountdown(seconds: number): string {
  const whole = Math.max(0, Math.floor(seconds))
  const minutes = Math.floor(whole / 60)
  const rest = whole % 60
  return `${String(minutes)}:${String(rest).padStart(2, '0')}`
}
