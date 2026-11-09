/**
 * The credential form's pending interaction.
 *
 * `conversation.composer` is a `chain` slot whose `select` receives the
 * session's `pendingInteraction`, so a component can only take the composer
 * over by publishing one. This is that object: it marks the form as the
 * session's live interaction, whether the form is up because a Host request
 * is waiting or because a chip opened it directly.
 *
 * Modelled on `dsh-client-ui-approval`'s `PendingApproval`: a request that
 * outlives a render needs an identity the framework can key on (`key`), and a
 * kind of its own (`kind`). Unlike the approval panel this one carries no
 * promise — the answer travels over the ordinary credential route, so there is
 * nothing here for the browser to resolve.
 *
 * @module @huaweidevtools/aishell-dsh-client-credentials/client/CredentialFormInteraction
 */

// Type-only: `SessionId` is a branded string, and the brand exists to stop
// arbitrary strings being passed where a session identity is meant. Here the
// value *is* a session identity — the Host sent it from a Session — so the
// brand is applied with a cast rather than by importing the runtime mint
// (`@deepseek-ai/dsh-session` is not in the browser's frozen module table, so a
// value import would fail to resolve in the bundle).
import type { SessionId } from '@deepseek-ai/dsh-session'

/** Monotonic source of `key`s, module-scoped like the approval panel's. */
let nextKey = 0

/**
 * One presentation of the credential form.
 *
 * The `key` is opaque to the framework and only has to change when the
 * presentation must remount; `kind` is this domain's own discriminator, which
 * nothing outside reads.
 *
 * An interface plus a factory rather than a class: the browser half is
 * compiled by oxc, and class syntax in that half has already tripped a
 * compiler panic once (see `credential-form-visibility.ts`). A plain object
 * carries the same three fields.
 */
export interface CredentialFormInteraction {
  /** Domain discriminator, for consumers that switch on interaction kind. */
  readonly kind: 'aishell-credential-form'
  /** Opaque render identity; a fresh key remounts the form (clearing it). */
  readonly key: string
  /**
   * The conversation the form belongs to. The slot is session-scoped, so this
   * is what decides where the form appears. Sent by the Host as a plain
   * string; branded by a cast (see the import note).
   */
  readonly sessionId: SessionId
}

/**
 * Build an interaction for one session.
 *
 * @param sessionId - the conversation the form belongs to.
 */
export function credentialFormInteraction(sessionId: string): CredentialFormInteraction {
  nextKey += 1
  return {
    kind: 'aishell-credential-form',
    key: `aishell-credential-form:${String(nextKey)}`,
    sessionId: sessionId as SessionId,
  }
}

/**
 * Test whether a pending interaction is this domain's form.
 *
 * The `select` in the composer chain needs a runtime check, and this is the one
 * place that knows what makes one — a kind tag rather than `instanceof`, which
 * a factory-produced object cannot offer.
 *
 * @param value - the session's pending interaction, or `undefined`.
 */
export function isCredentialForm(value: unknown): value is CredentialFormInteraction {
  return (value as { kind?: unknown } | null | undefined)?.kind === 'aishell-credential-form'
}
