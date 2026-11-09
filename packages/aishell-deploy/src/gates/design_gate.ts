/**
 * The gate `terraform_apply` runs on the network design.
 *
 * ## What it checks, and what it deliberately does not
 *
 * The design IS the `.tf`: there is no separate description of the network, so
 * "has the design been checked" can only be asked of the configuration itself.
 * This gate asks two questions, both answerable without a cloud credential:
 *
 *   1. Do the `.tf` files declare any network resources at all? A deployment
 *      that plans to create compute in a subnet it never wrote is a plan that
 *      will fail on an unresolved reference — the error terraform gives points
 *      at the compute block, several steps from the omission that caused it.
 *
 *   2. Did `validate_design` run over THIS configuration?
 *
 * The second is a hash, not a timestamp or a boolean. `validate_design`
 * records the digest of the configuration it checked; this gate recomputes the
 * digest from the files on disk and refuses when they differ. A design edited
 * after it was checked is not a checked design — and a boolean would have said
 * it was.
 *
 * ## Why the evidence is a digest of the configuration
 *
 * The design IS the `.tf`. Any separate statement of the network — a file the
 * model fills in beside it — is a second description that nothing reconciles
 * with the first, so passing a gate on it would prove only that somebody wrote
 * something down. A digest of the configuration is evidence about the thing
 * that will be built, which is the only thing worth approving.
 *
 * ## What it still does not do
 *
 * It does not re-run `terraform validate`. That is `validate_design`'s job, and
 * it is the check whose result is recorded — a design that failed validation
 * is recorded as failed and this gate refuses it.
 *
 * @module @huaweidevtools/aishell-dsh-deploy/gates/design_gate
 */

import type { DeploymentSnapshot } from '../deployment-state.ts'
import { parseConfiguration } from '../hcl.ts'
import { computeTfHash } from '../utils/hash.ts'

/**
 * Terraform types that make up the network, rather than the workload on it.
 *
 * A prefix test rather than a list: the provider has ~77 types under these
 * prefixes and adds more; the question here is only "does this deployment
 * describe a network", which any of them answers.
 */
const NETWORK_TYPE_PREFIXES = [
  'huaweicloud_vpc',
  'huaweicloud_networking_secgroup',
  'huaweicloud_nat_',
  'huaweicloud_elb_',
] as const

/**
 * Whether one resource type is part of the network design.
 *
 * @param type - the resource type.
 * @returns whether it counts as network.
 */
export function isNetworkType(type: string): boolean {
  return NETWORK_TYPE_PREFIXES.some(prefix => type.startsWith(prefix))
}

/**
 * The state a deployment records about its design check.
 *
 * Written by `validate_design`. `tf_hash` is the digest of the configuration
 * that was checked; `ok` is whether it passed, so a recorded failure cannot be
 * read as a pass.
 */
export interface DesignCheck {
  readonly tf_hash: string
  readonly ok: boolean
  readonly checked_at: string
}

/**
 * Refuse an apply whose network design was never checked, or changed since.
 *
 * @param directory - the deployment workspace directory.
 * @param readState - reader for the deployment snapshot, injected so the check
 *   is testable without a filesystem.
 * @param hashConfiguration - digest of the configuration on disk.
 * @throws when the design is absent, unchecked, failed, or stale.
 */
export async function assertDesignChecked(
  directory: string,
  readState: (dir: string) => Promise<DeploymentSnapshot | undefined>,
  hashConfiguration: (dir: string) => Promise<string>,
): Promise<void> {
  const declared = await networkResourceCount(directory)
  if (declared === 0) {
    throw new Error(
      'the .tf files declare no network resources (VPC, subnet, security group, '
      + 'NAT or load balancer). Add the network before adding the workload on it — '
      + 'compute placed in a subnet that does not exist fails on an unresolved '
      + 'reference that names the compute block rather than the missing network.',
    )
  }

  const state = await readState(directory)
  const check = state?.status.design_check
  if (check === undefined) {
    throw new Error(
      'this deployment\'s network design has never been checked. '
      + 'Call validate_design — it runs terraform validate, reports the network '
      + 'problems terraform cannot see, and draws the topology for the user to '
      + 'approve. Then apply.',
    )
  }

  if (!check.ok) {
    throw new Error(
      'the last validate_design run on this configuration FAILED. Fix the '
      + 'diagnostics it reported, call it again, and get the user\'s agreement on '
      + 'the corrected design. A failed design is not an approved one.',
    )
  }

  const current = await hashConfiguration(directory)
  if (current !== check.tf_hash) {
    throw new Error(
      'the .tf files changed after the network design was checked. '
      + 'Call validate_design again: it re-checks the configuration and shows the '
      + 'user the current topology. Applying a design nobody reviewed is what this '
      + 'refusal prevents.',
    )
  }
}

/**
 * How many network resources the configuration declares.
 *
 * A file that does not parse contributes nothing; `validate_design` is where a
 * syntax error is reported, and a parse failure here would otherwise be
 * reported as "no network" — the wrong diagnosis for a file that has one.
 *
 * @param directory - the deployment workspace directory.
 * @returns the count of network resource blocks.
 */
async function networkResourceCount(directory: string): Promise<number> {
  const { blocks } = await parseConfiguration(directory)
  return blocks.filter(block => isNetworkType(block.type)).length
}

/** The digest function the gate uses; re-exported so a caller cannot pass a different one by accident. */
export { computeTfHash }