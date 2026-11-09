/**
 * The apply gate on the network design.
 *
 * The design IS the `.tf`, so this gate asks two things of the configuration
 * itself: that it declares a network, and that `validate_design` checked THAT
 * configuration rather than an earlier one.
 *
 * The stale-design case is the reason the record carries a digest instead of a
 * boolean. A boolean answers "was anything checked", and the question a gate
 * has to answer is "was this checked" — the two differ exactly when someone
 * edits a design after approving it, which is the case worth refusing.
 */

import { describe, it, expect } from 'vitest'

import { assertDesignChecked, isNetworkType } from '../src/gates/design_gate.ts'
import type { DeploymentSnapshot } from '../src/deployment-state.ts'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** A minimal network configuration. */
const NETWORK_TF = `
resource "huaweicloud_vpc" "prod" {
  name = "prod-vpc"
  cidr = "10.0.0.0/16"
}
`

/** A deployment with only a workload and no network. */
const WORKLOAD_ONLY_TF = `
resource "huaweicloud_compute_instance" "web" {
  name      = "web"
  flavor_id = "c7.large.2"
  image_id  = "img"
}
`

/** The digest every test's fixture is recorded against, unless it says otherwise. */
const CHECKED_HASH = 'hash-of-the-checked-configuration'

/**
 * A snapshot recording a design check.
 *
 * @param overrides - fields to replace on the recorded check.
 * @returns the snapshot.
 */
function snapshotWithCheck(overrides: Partial<{ tf_hash: string, ok: boolean }> = {}): DeploymentSnapshot {
  return {
    created_at: '2026-01-01T00:00:00.000Z',
    created_with: 'aishell-deploy',
    server_version: '0.0.0-test',
    status: {
      design_check: {
        tf_hash: CHECKED_HASH,
        ok: true,
        checked_at: '2026-01-01T00:00:00.000Z',
        ...overrides,
      },
      cost_written: false,
      applied: false,
      destroyed: false,
      last_operation: 'validate_design',
      last_operation_at: '2026-01-01T00:00:00.000Z',
    },
  }
}

/** Write one `.tf` file into a fresh directory and run the gate on it. */
async function gate(
  source: string,
  snapshot: DeploymentSnapshot | undefined,
  currentHash = CHECKED_HASH,
): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'design-gate-'))
  try {
    await writeFile(join(dir, 'main.tf'), source, 'utf8')
    await assertDesignChecked(
      dir,
      () => Promise.resolve(snapshot),
      () => Promise.resolve(currentHash),
    )
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

describe('isNetworkType', () => {
  it('counts the network a workload sits on', () => {
    expect(isNetworkType('huaweicloud_vpc')).toBe(true)
    expect(isNetworkType('huaweicloud_vpc_subnet')).toBe(true)
    expect(isNetworkType('huaweicloud_networking_secgroup')).toBe(true)
    expect(isNetworkType('huaweicloud_nat_gateway')).toBe(true)
    expect(isNetworkType('huaweicloud_elb_loadbalancer')).toBe(true)
  })

  it('does not count the workload itself', () => {
    expect(isNetworkType('huaweicloud_compute_instance')).toBe(false)
    expect(isNetworkType('huaweicloud_rds_instance')).toBe(false)
  })
})

describe('assertDesignChecked', () => {
  it('passes a configuration that was checked and has not changed', async () => {
    await expect(gate(NETWORK_TF, snapshotWithCheck())).resolves.toBeUndefined()
  })

  it('refuses a deployment that declares no network', async () => {
    // The error terraform gives for compute in a nonexistent subnet names the
    // compute block, several steps from the omission that caused it.
    await expect(gate(WORKLOAD_ONLY_TF, snapshotWithCheck()))
      .rejects.toThrow(/no network resources/)
  })

  it('refuses a deployment whose design was never checked', async () => {
    await expect(gate(NETWORK_TF, undefined))
      .rejects.toThrow(/never been checked/)
  })

  it('refuses a deployment with a snapshot but no design check', async () => {
    const snapshot: DeploymentSnapshot = {
      ...snapshotWithCheck(),
      status: {
        cost_written: false,
        applied: false,
        destroyed: false,
        last_operation: 'create_deployment',
        last_operation_at: '2026-01-01T00:00:00.000Z',
      },
    }
    await expect(gate(NETWORK_TF, snapshot))
      .rejects.toThrow(/never been checked/)
  })

  it('refuses a design whose last check FAILED', async () => {
    // A recorded failure must not read as an approval. The model has to fix
    // what validate_design reported and run it again.
    await expect(gate(NETWORK_TF, snapshotWithCheck({ ok: false })))
      .rejects.toThrow(/FAILED/)
  })

  it('refuses a design edited after it was checked', async () => {
    // The case a boolean record cannot catch: the design WAS checked, and the
    // file has since changed.
    await expect(gate(NETWORK_TF, snapshotWithCheck(), 'a-different-hash'))
      .rejects.toThrow(/changed after the network design was checked/)
  })

  it('names what to do about a stale design', async () => {
    await expect(gate(NETWORK_TF, snapshotWithCheck(), 'a-different-hash'))
      .rejects.toThrow(/validate_design/)
  })

  it('treats a file that does not parse as contributing nothing', async () => {
    // A syntax error is `validate_design`'s to report. Reporting it here as
    // "no network" would name the wrong problem.
    await expect(gate('resource "huaweicloud_vpc" "v" {\n', snapshotWithCheck()))
      .rejects.toThrow(/no network resources/)
  })
})