/**
 * Whether this deployment has the huaweicloud provider installed.
 *
 * ## Why this is a question about files, not about terraform
 *
 * `terraform validate` refuses a configuration whose provider is absent — it
 * answers "requires provider registry.terraform.io/huaweicloud/huaweicloud,
 * but that provider isn't available" (verified against terraform 1.x with no
 * `.terraform` directory). That message describes the install state, not the
 * configuration, but a caller that only reads terraform's exit code cannot
 * tell those apart.
 *
 * So the install state is decided here, from the directory terraform itself
 * writes: `terraform init` unpacks providers into
 * `<deployment>/.terraform/providers/<registry-address>/`. The directory is the
 * signal, and it needs no subprocess, no credentials, and no network.
 *
 * `validate` also needs `.terraform.lock.hcl` to agree. A lock file naming the
 * provider without the matching directory is the state `init` did not finish,
 * and validate refuses it as an inconsistent lock — a different message for
 * the same cause, so both halves are required here.
 *
 * @module @huaweidevtools/aishell-dsh-deploy/gates/provider_installed
 */

import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'

/** The registry address terraform uses for this provider. */
const HUAWEICLOUD_ADDRESS = 'registry.terraform.io/huaweicloud/huaweicloud'

/** Where `terraform init` unpacks providers, relative to the deployment. */
const PROVIDERS_DIR = join('.terraform', 'providers')

/** The lock file `terraform init` writes, relative to the deployment. */
const LOCK_FILE = '.terraform.lock.hcl'

/**
 * Whether the huaweicloud provider is installed and locked in this deployment.
 *
 * @param deployment - the deployment workspace directory.
 * @returns `true` when `terraform validate` can run against the provider.
 */
export async function providerInstalled(deployment: string): Promise<boolean> {
  if (!(await providerUnpacked(deployment))) return false
  return lockFileNamesProvider(deployment)
}

/**
 * Whether the provider's package is on disk.
 *
 * The path is `<providers>/<registry-host>/<namespace>/<type>/`, because
 * terraform lays providers out by registry address. Matching the address
 * segment by segment keeps a mirror-installed provider (which lands under the
 * same address) working, while a different provider in the same deployment
 * does not satisfy the check.
 *
 * @param deployment - the deployment workspace directory.
 * @returns `true` when the address resolves to a non-empty directory.
 */
async function providerUnpacked(deployment: string): Promise<boolean> {
  const [host, namespace, type] = HUAWEICLOUD_ADDRESS.split('/')
  if (host === undefined || namespace === undefined || type === undefined) return false
  const dir = join(deployment, PROVIDERS_DIR, host, namespace, type)
  try {
    const versions = await readdir(dir)
    return versions.length > 0
  } catch {
    return false
  }
}

/**
 * Whether the lock file names the provider.
 *
 * The lock file is HCL, and this reads it as text rather than parsing it: the
 * only question is whether the provider's address appears as a `provider`
 * entry, and a substring test on the address is what answers that. A false
 * positive would have to come from the address appearing in a comment, and the
 * cost of being wrong is a validation attempt that reports a consistent-lock
 * error — which the caller already handles as "validation did not run".
 *
 * @param deployment - the deployment workspace directory.
 * @returns `true` when the lock file lists the provider.
 */
async function lockFileNamesProvider(deployment: string): Promise<boolean> {
  let text: string
  try {
    text = await readFile(join(deployment, LOCK_FILE), 'utf8')
  } catch {
    return false
  }
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    // A provider entry reads: provider "registry.terraform.io/huaweicloud/huaweicloud" {
    if (trimmed.startsWith('provider ') && trimmed.includes(`"${HUAWEICLOUD_ADDRESS}"`)) return true
  }
  return false
}