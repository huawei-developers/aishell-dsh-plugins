/**
 * The gate that makes `terraform_apply` run the plan the user approved.
 *
 * ## The gap it closes
 *
 * `terraform apply` re-plans by default. That means the changes it makes are
 * computed at apply time, from whatever the configuration says THEN — not the
 * ones the user looked at in `terraform_plan`. Verified: `terraform apply
 * <saved-plan>` executes the saved plan and does NOT check that the `.tf` still
 * matches it, so terraform itself offers no protection either way.
 *
 * So the approval step has to be enforced here, and it is enforcement of two
 * facts:
 *
 *   1. A plan exists, produced by `terraform_plan` for THIS configuration
 *      (its digest matches the `.tf` on disk).
 *   2. Apply runs THAT plan file, not a fresh computation.
 *
 * ## Why the digest and not the plan file's timestamp
 *
 * A plan file has no intrinsic link to the configuration it came from —
 * terraform will happily apply one whose `.tf` has since changed, as the test
 * above shows. So the record of "which configuration this plan describes" has
 * to be kept beside it, and the digest is that record. A timestamp would only
 * say when someone ran the command.
 *
 * ## What this gate does NOT check
 *
 * Whether the user actually looked. That is not observable from here, and the
 * prompt says to show the plan and get agreement. What IS observable is that a
 * specific set of changes was computed and approved as a unit, and that apply
 * executes exactly it — which is the property that matters when the answer to
 * "was this reviewed" is "reviewed for a different plan".
 *
 * @module @huaweidevtools/aishell-dsh-deploy/gates/plan_gate
 */

import { access } from 'node:fs/promises'
import { join } from 'node:path'

import { computeTfHash } from '../utils/hash.ts'
import type { DeploymentSnapshot } from '../deployment-state.ts'

/** Where `terraform_plan` writes the plan it computes. */
export const PLAN_FILE = 'plan.tfplan'

/**
 * The record `terraform_plan` writes about the plan it produced.
 *
 * Stored in the deployment snapshot rather than beside the plan file: the file
 * is a terraform artifact and a second file next to it would be one more thing
 * to keep in step. The snapshot is already the place this plugin records what
 * it has done.
 */
export interface PlanRecord {
  /** Digest of the configuration the plan was computed from. */
  readonly tf_hash: string
  /** When the plan ran. */
  readonly planned_at: string
  /**
   * What the plan would do, as counts — absent when the plan produced no
   * readable change list, which is different from "changes nothing".
   */
  readonly actions?: { readonly create: number, readonly change: number, readonly destroy: number }
}

/**
 * Refuse an apply that has no approved plan, or whose plan is for a
 * configuration that has since changed.
 *
 * @param directory - the deployment workspace directory.
 * @param readState - reader for the deployment snapshot.
 * @param hashConfiguration - digest of the configuration on disk.
 * @throws when there is no plan, no record of it, or the record is stale.
 */
export async function assertPlanApproved(
  directory: string,
  readState: (dir: string) => Promise<DeploymentSnapshot | undefined>,
  hashConfiguration: (dir: string) => Promise<string>,
): Promise<void> {
  const planExists = await access(join(directory, PLAN_FILE)).then(
    () => true,
    () => false,
  )
  if (!planExists) {
    throw new Error(
      `no ${PLAN_FILE} in this deployment. Call terraform_plan first: it computes the changes `
      + 'and saves them, and terraform_apply runs THAT plan. Applying without one would compute '
      + 'the changes at apply time — possibly different from what the user agreed to.',
    )
  }

  const state = await readState(directory)
  const record = state?.status.plan_check
  if (record === undefined) {
    throw new Error(
      `this deployment has a ${PLAN_FILE} but no record of which configuration produced it. `
      + 'Call terraform_plan again — it records the digest of the configuration it planned.',
    )
  }

  const current = await hashConfiguration(directory)
  if (current !== record.tf_hash) {
    throw new Error(
      'the .tf files changed after the plan was computed. The saved plan describes a different '
      + 'configuration from the one on disk, so applying it would make changes nobody reviewed. '
      + 'Call terraform_plan again and show the user the new changes.'
    )
  }
}

/** The digest function the gate uses, re-exported so a caller cannot pass another by accident. */
export { computeTfHash }

/** Where `terraform_plan({ destroy: true })` writes the destruction it previewed. */
export const DESTROY_PLAN_FILE = 'destroy.plan.tfplan'

/**
 * The record `terraform_plan({ destroy: true })` writes about what it previewed.
 *
 * `targets` is empty for a full teardown and the addresses otherwise. It is
 * stored because the preview and the destruction must name the same resources:
 * applying a whole-deployment teardown because someone asked to remove one
 * instance is the worst outcome available here, and the two lists are the only
 * thing that can tell them apart.
 */
export interface DestroyRecord {
  /** Digest of the configuration the preview was computed from. */
  readonly tf_hash: string
  readonly previewed_at: string
  /** The addresses previewed, or empty for the whole deployment. */
  readonly targets: readonly string[]
}

/**
 * Refuse a destroy with no preview, or one that passes for a different teardown.
 *
 * `terraform destroy -auto-approve` computes its own plan, so the list the user
 * approved and the resources that disappear are two separate computations —
 * and anything can change between them: a refresh, a console edit, a failed
 * apply. Applying the previewed plan file instead makes the destruction
 * exactly what was shown, and terraform refuses a plan whose state has moved
 * on since. Verified: `plan -destroy -target=A -out=f` followed by `apply f`
 * removes A and leaves B.
 *
 * Three questions, each one a way the preview and the request can disagree:
 * does a preview exist, does it cover the same targets, and was it computed
 * from the configuration still on disk.
 *
 * @param directory - the deployment workspace directory.
 * @param readState - reader for the deployment snapshot.
 * @param hashConfiguration - digest of the configuration on disk.
 * @param targets - the addresses this call intends to destroy; empty for all.
 * @throws when there is no preview, it covers a different set, or it is stale.
 */
export async function assertDestroyPreviewed(
  directory: string,
  readState: (dir: string) => Promise<DeploymentSnapshot | undefined>,
  hashConfiguration: (dir: string) => Promise<string>,
  targets: readonly string[],
): Promise<void> {
  const previewExists = await access(join(directory, DESTROY_PLAN_FILE)).then(
    () => true,
    () => false,
  )
  if (!previewExists) {
    throw new Error(
      `no ${DESTROY_PLAN_FILE} in this deployment. Call terraform_plan with destroy: true ` +
      'first, show the user the list of resources it would remove, and then call ' +
      'terraform_destroy with the same targets. Destroying without a preview computes the ' +
      "list at destroy time, which need not be the list they agreed to.",
    )
  }

  const state = await readState(directory)
  const record = state?.status.destroy_check
  if (record === undefined) {
    throw new Error(
      `this deployment has a ${DESTROY_PLAN_FILE} but no record of what was previewed. ` +
      'Call terraform_plan with destroy: true again — it records the change set it computed.',
    )
  }

  const previewed = [...record.targets].sort()
  const requested = [...targets].sort()
  if (previewed.join('\u0000') !== requested.join('\u0000')) {
    const described = (list: readonly string[]): string => (list.length === 0
      ? 'the whole deployment'
      : `only ${list.join(', ')}`)
    throw new Error(
      `the teardown previewed ${described(previewed)}, but this call asks to destroy ` +
      `${described(requested)}. That is a different set of resources from the one the user ` +
      'approved. Call terraform_plan with destroy: true and the targets you intend to destroy, ' +
      'show that list, and then call terraform_destroy with the same targets.',
    )
  }

  const current = await hashConfiguration(directory)
  if (current !== record.tf_hash) {
    throw new Error(
      'the .tf files changed after the teardown was previewed. The saved destroy plan ' +
      'describes a different configuration. Call terraform_plan with destroy: true again and ' +
      'show the new list before destroying.',
    )
  }
}