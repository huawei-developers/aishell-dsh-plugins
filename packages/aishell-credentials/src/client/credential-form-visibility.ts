/**
 * Decides when the credential form is up.
 *
 * Kept out of the plugin body because it is the part that is easy to get wrong
 * and impossible to see going wrong: an interaction that is published and never
 * withdrawn leaves the form on screen, and nothing throws. The plugin body wires
 * this to the slot registry; this module holds only the decision.
 *
 * ## One way the form comes up
 *
 * A chip opens it, and that is the whole model. Every rule here exists to serve
 * that single door:
 *
 *   - An open while the form is already up is a no-op. Publishing a second
 *     interaction would remount the component and discard what was typed.
 *   - A close, or a dispose, withdraws it, and the ordinary composer comes back.
 *
 * No other producer exists, so no rule is needed for one. A second source would
 * need rules about which owns the form and how a takeover republishes it — and
 * those rules would be describing a situation the system cannot reach.
 *
 * ## Why a closure and not a class
 *
 * Written as a factory because the browser half is compiled by oxc, and a class
 * with private (`#`) fields makes that compiler panic
 * (`oxc_transformer ... es2022/class_properties/class_details.rs:138:
 * internal error: entered unreachable code`), which fails the CJS build and
 * leaves `lib/client.js` unwritten — DSH then refuses to start. The state here
 * is two variables either way, so the closure costs nothing and cannot trip it.
 *
 * @module @huaweidevtools/aishell-dsh-client-credentials/client/credential-form-visibility
 */

import { credentialFormInteraction, type CredentialFormInteraction } from './CredentialFormInteraction.ts'

/** Publishes one interaction and returns the function that withdraws it. */
export type PublishInteraction = (interaction: CredentialFormInteraction) => () => void

/** Select one conversation as the visible one. */
export type RevealSession = (sessionId: string) => void

/**
 * Whether the framework still has this interaction in front of a composer.
 *
 * The machine's own `open` variable is not authority for that. It is set when
 * the interaction is published and cleared only by an explicit `close()`, while
 * the card can leave the screen by paths that never call one — a workspace
 * switch, a re-render that unmounts the chain. Reading the registry back is
 * what keeps a stale record from sending someone to a conversation with no form
 * on it.
 *
 * @param interaction - the interaction this machine last published.
 */
export type IsStillPending = (interaction: CredentialFormInteraction) => boolean

/** Opens and closes the form on the composer's pending interaction. */
export interface CredentialFormVisibility {
  /**
   * Open the form for one session, or show the session that already has it.
   *
   * Three cases, and the third is why this is not just "publish if absent":
   *
   *   - Nothing open — publish, and the form appears here.
   *   - Open in THIS conversation — no-op. The person is looking at it, and a
   *     second interaction would carry a new key, so the framework would remount
   *     the component and throw away the half-typed AK/SK.
   *   - Open in a DIFFERENT conversation — navigate there instead. The card is
   *     already on screen over there, and the form is a single process-wide
   *     thing (one login at a time, one credential store), so publishing a
   *     second card would give two conversations a live form over one store.
   *     Moving the person to the card they already have is the honest answer,
   *     and it is what keeps the chip alive across a conversation switch: the
   *     card is still on screen, just not in the conversation that was clicked.
   *
   * @param sessionId - the conversation the person is acting in.
   */
  readonly open: (sessionId: string) => void
  /** Withdraw the open form, if any, restoring the ordinary composer. */
  readonly close: () => void
  /** The interaction currently published, if any. For tests and diagnostics. */
  readonly current: () => CredentialFormInteraction | undefined
  /** Withdraw any open form. Called when the plugin fiber is disposed. */
  readonly dispose: () => void
}

/** How the visibility state machine reaches the rest of the product. */
export interface CredentialFormVisibilityDeps {
  /** How to put an interaction in front of the composer. */
  readonly publish: PublishInteraction
  /**
   * How to select another conversation, as the sidebar does.
   *
   * Injected rather than imported so the decision can be tested without a UI,
   * and so this module stays free of framework navigation types.
   */
  readonly revealSession: RevealSession
  /**
   * How to ask whether a published interaction is still on screen.
   *
   * See {@link IsStillPending} for why the machine cannot answer this itself.
   */
  readonly isStillPending: IsStillPending
}

/**
 * Build the visibility state machine.
 *
 * @param deps - publishing and navigation.
 */
export function createCredentialFormVisibility(
  deps: CredentialFormVisibilityDeps,
): CredentialFormVisibility {
  const { publish, revealSession, isStillPending } = deps
  let open: CredentialFormInteraction | undefined
  let withdraw: (() => void) | undefined

  const clear = (): void => {
    withdraw?.()
    withdraw = undefined
    open = undefined
  }

  return {
    current: () => open,

    open: (sessionId) => {
      if (open !== undefined && isStillPending(open)) {
        // Genuinely on screen — either here, where republishing would remount
        // and discard what was typed, or in another conversation, where the
        // person needs to be shown the card rather than given a second one over
        // the same single credential store.
        if (open.sessionId !== sessionId) revealSession(open.sessionId)
        return
      }
      // The remembered interaction is gone from the registry: the card left the
      // screen without an explicit close. Drop the stale record and its
      // withdrawal before publishing, or the record would keep answering for a
      // form that is no longer anywhere.
      if (open !== undefined) clear()
      const interaction = credentialFormInteraction(sessionId)
      open = interaction
      withdraw = publish(interaction)
    },

    close: () => {
      if (open === undefined) return
      clear()
    },

    dispose: () => {
      if (open === undefined) return
      clear()
    },
  }
}