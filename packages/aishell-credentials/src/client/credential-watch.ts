/**
 * The credential watch: keeps the signed-in state honest about IAM.
 *
 * ## What it is for
 *
 * A stored pair can stop working with nothing in the store changing — an
 * expired STS token, a key deleted in the console. The card and the chips read
 * a status document the Host writes from the store, so without a check they go
 * on reporting "signed in" until something else happens to call IAM. The first
 * thing to notice is then a failing tool call, which reads to the person as the
 * product contradicting itself.
 *
 * This asks the Host to re-check, on a cadence, and stops the moment the answer
 * cannot matter.
 *
 * ## Why the cadence lives in the browser
 *
 * The Host cannot see whether a window is on screen. A timer there would keep
 * spending IAM quota on a credential nobody is looking at — and a desktop app
 * is usually open and unwatched, which is exactly the case a Host timer handles
 * badly. `document.visibilityState` is the fact only this side has.
 *
 * ## When it does not run
 *
 * Three states, and each is a reason not to ask rather than a reason to ask
 * less often:
 *
 *   - **Nothing stored.** There is no credential to verify; the form is the
 *     only way one arrives, and a save starts the watch again.
 *   - **The page is hidden.** A status that changed while the person was away
 *     is picked up on the first tick after they come back, and until then there
 *     is nobody to be misled.
 *   - **IAM is unreachable.** The credential is probably fine and IAM is not;
 *     retrying on the ordinary period turns one outage into a steady stream of
 *     failing calls. Backing off is what keeps a temporary fault temporary.
 *
 * The decision itself is in `../revalidate.ts` so it is drivable from a spec;
 * this module owns the timer and the fetch, which are not.
 *
 * @module @huaweidevtools/aishell-dsh-client-credentials/client/credential-watch
 */

import { nextCheckDelay } from '../revalidate.ts'

/** What one revalidation found, as the route reports it. */
export type RevalidateState =
  /** IAM accepted the pair. */
  | 'valid'
  /** IAM refused it; the Host has cleared the store. */
  | 'discarded'
  /** No credential is stored here. */
  | 'absent'
  /** The call did not reach IAM. Says nothing about the credential. */
  | 'unreachable'

/** How often to re-check while the page is visible and IAM answers. */
export const WATCH_PERIOD_MS = 60_000

/** Collaborators the watch runs against; injected so a spec can drive it. */
export interface CredentialWatchDeps {
  /** Whether a credential is currently stored, as the status document says. */
  readonly hasCredential: () => boolean
  /** Asks the Host to re-check. Resolves `undefined` when the route could not be reached. */
  readonly revalidate: (signal: AbortSignal) => Promise<RevalidateState | undefined>
  /** Whether a page can see the watch run; defaults to `document.visibilityState`. */
  readonly isVisible?: () => boolean
}

/** The watch, as the plugin body holds it. */
export interface CredentialWatch {
  /**
   * Schedule a check from now, keeping the backoff.
   *
   * For a page becoming visible: the person is back, but nothing about the
   * credential changed, so an unreachable IAM is still unreachable and the
   * backoff it earned still stands.
   */
  readonly arm: () => void
  /**
   * Schedule a check from now and forget the backoff.
   *
   * For a credential arriving. A save or a login replaces the material being
   * verified, so whatever failed before was a different question.
   */
  readonly reset: () => void
  /** Stop the timer. Called when the plugin fiber is disposed. */
  readonly stop: () => void
}

/**
 * Start watching the stored credential.
 *
 * One timer, re-armed after each check rather than running on a fixed interval:
 * the delay depends on the last answer, and an interval would either ignore the
 * backoff or have to be torn down and rebuilt for it.
 *
 * @param deps - presence, the check, and what to do with its answer.
 * @returns the handle the caller uses to restart or stop it.
 */
export function startCredentialWatch(deps: CredentialWatchDeps): CredentialWatch {
  const isVisible = deps.isVisible ?? ((): boolean => document.visibilityState === 'visible')
  let timer: ReturnType<typeof setTimeout> | undefined
  /** Consecutive checks that never reached IAM; drives the backoff. */
  let consecutiveUnreachable = 0
  /**
   * Whether a check is in flight.
   *
   * A check costs an IAM round trip and can take longer than the ordinary
   * period. Re-arming while one is out would let two overlap — and a save, a
   * visibility change and a timer can all land in that window. One at a time is
   * the only bound that keeps the quota spent proportional to the period.
   */
  let inFlight = false
  let stopped = false
  /**
   * The check currently out, so disposing the plugin can drop it.
   *
   * A request left running after the fiber is gone reaches the Host after the
   * page has stopped caring — at worst clearing a store for a reload that has
   * already replaced it, at least spending IAM quota after the plugin that
   * asked for it no longer exists.
   */
  let controller: AbortController | undefined

  const clear = (): void => {
    if (timer !== undefined) clearTimeout(timer)
    timer = undefined
  }

  const tick = async (): Promise<void> => {
    timer = undefined
    if (stopped || inFlight) return
    inFlight = true
    controller = new AbortController()
    let state: RevalidateState | undefined
    try {
      state = await deps.revalidate(controller.signal)
    } finally {
      // In `finally` so a check that threw — a fetch rejected in a way the
      // caller did not absorb — cannot leave `inFlight` stuck true and stop the
      // watch for the life of the page.
      inFlight = false
      controller = undefined
    }
    if (stopped) return
    // A failed request is not an answer about the credential, but it is also not
    // a reason to poll at full rate: the Host or the network is not answering,
    // and the next attempt costs the same.
    if (state === undefined || state === 'unreachable') consecutiveUnreachable += 1
    else consecutiveUnreachable = 0
    schedule()
  }

  // Declared after `tick`, which it calls: a timer only ever runs it later, but
  // a `const` read before its declaration would throw rather than schedule.
  const schedule = (): void => {
    clear()
    if (stopped || inFlight) return
    const delay = nextCheckDelay({
      hasCredential: deps.hasCredential(),
      visible: isVisible(),
      consecutiveUnreachable,
      periodMs: WATCH_PERIOD_MS,
    })
    // `undefined` is "do not schedule": something else — a save, a visibility
    // change — will arm it again. A timer that kept firing here would be the
    // poll this module exists to avoid.
    if (delay === undefined) return
    timer = setTimeout(() => { void tick() }, delay)
  }

  schedule()

  return {
    arm: () => {
      stopped = false
      // A check already out will schedule the next one when it returns, so
      // there is nothing to add here.
      schedule()
    },
    reset: () => {
      stopped = false
      consecutiveUnreachable = 0
      schedule()
    },
    stop: () => {
      stopped = true
      clear()
      controller?.abort()
    },
  }
}