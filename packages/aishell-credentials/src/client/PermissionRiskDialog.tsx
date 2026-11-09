/**
 * The read-write risk gate, shared by both permission chips.
 *
 * ## Why a flip to read-write asks first
 *
 * The mode is the one setting in this plugin set that changes what the agent may
 * do to a real cloud account. Read-only is enforced by the host gate — mutations
 * are refused there — so leaving it is the moment a mistake stops being
 * recoverable: a destroyed resource usually does not come back, a security-group
 * edit can take a running service off the network, and everything created bills
 * until it is torn down. One click is too cheap an entry to that.
 *
 * The reverse direction does not ask. Read-only gives up access; there is no
 * consequence to warn about, and a dialog there would train people to dismiss
 * the one that matters.
 *
 * ## Why `RiskConfirmation` and not a bespoke dialog
 *
 * It is the framework's own primitive, and it is already the shape the shell
 * uses for the sandbox's "Full access" gate — an acknowledgement checkbox that
 * keeps the primary button dead until it is ticked. Using it here means the two
 * escalations in this product look and behave the same, and it brings the modal
 * layer, focus trap and escape handling with it rather than an approximation of
 * them. It portals to the body, so being mounted inside the chips' `inline-flex`
 * row costs nothing.
 *
 * ## Why the state lives in the hook, not here
 *
 * This renders what `usePermissionMode` holds. Both chips drive the same
 * host-side switch, so a dialog owned per chip would be two independent gates
 * over one value — open both, confirm in one, and the other still offers to
 * enable a mode that is already current. See `permission-mode.ts`.
 *
 * @module @huaweidevtools/aishell-dsh-client-credentials/client/PermissionRiskDialog
 */

import type { ReactNode } from 'react'
import { RiskConfirmation } from '@deepseek-ai/dsh-client-ui-primitives'
// Type-only: merges the `aishell` key into LocaleNamespaceMap.
import type {} from './locales.ts'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { PermissionConfirmation } from './permission-mode.ts'

/** Props: the gate's state, the two callbacks, and the dictionary. */
export interface PermissionRiskDialogProps {
  /** The pending confirmation, or `undefined` when none is open. */
  readonly confirmation: PermissionConfirmation | undefined
  /** Dismiss without flipping. */
  readonly onCancel: () => void
  /** Apply the flip; the acknowledgement must be ticked. */
  readonly onConfirm: () => void
  readonly t: TranslateNS<'aishell'>
}

/**
 * Render the gate when a read-write flip is waiting on the person.
 *
 * @param props - see {@link PermissionRiskDialogProps}.
 * @returns the dialog, or `null` when nothing is pending.
 */
export function PermissionRiskDialog(props: PermissionRiskDialogProps): ReactNode {
  const { confirmation, onCancel, onConfirm, t } = props
  if (confirmation === undefined) return null
  return (
    <RiskConfirmation
      open
      title={t('mode.confirm.title')}
      description={t('mode.confirm.description')}
      acknowledgeLabel={t('mode.confirm.acknowledge')}
      cancelLabel={t('mode.confirm.cancel')}
      closeLabel={t('mode.confirm.close')}
      confirmLabel={t('mode.confirm.enable')}
      acknowledged={confirmation.acknowledged}
      onAcknowledgedChange={(acknowledged) => { confirmation.setAcknowledged(acknowledged) }}
      onCancel={onCancel}
      onConfirm={onConfirm}
    />
  )
}