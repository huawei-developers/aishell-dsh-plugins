/**
 * What a saved plan is good for, and what happens once it is spent.
 *
 * A plan file is a one-shot artifact. terraform refuses to apply the same one
 * twice — "Saved plan is stale / the given plan file can no longer be applied
 * because the state was changed by another operation after the plan was
 * created" (measured against terraform 1.15 with stdin closed, which is how
 * the plugin runs it).
 *
 * Every record this plugin keeps still matches after a successful apply,
 * because applying does not change the `.tf`. So the second call would clear
 * every gate and fail on terraform's message, which names neither the gate nor
 * the remedy. Clearing the records is what turns that into "call
 * terraform_plan first".
 *
 * These pin the bookkeeping half; the terraform half needs a binary and is
 * covered by the note above rather than by a test that would download one.
 */

import { describe, it, expect } from 'vitest'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { assertPlanApproved, PLAN_FILE } from '../src/gates/plan_gate.ts'
import { clearPlanRecords, DEPLOYMENT_STATE_FILE, ensureDeployment, type DeploymentSnapshot } from '../src/deployment-state.ts'
import { stateInventory, stateResource } from '../src/tools/terraform.ts'

/** A snapshot recording a plan of `hash-a`. */
function planned(): DeploymentSnapshot {
  return {
    created_at: '2026-11-07T00:00:00.000Z',
    created_with: 'aishell-deploy',
    server_version: '0.0.0-test',
    status: {
      cost_written: true,
      applied: false,
      destroyed: false,
      plan_check: { tf_hash: 'hash-a', planned_at: '2026-11-07T00:00:00.000Z' },
      last_operation: 'terraform_plan',
      last_operation_at: '2026-11-07T00:00:00.000Z',
    },
  }
}

const hashA = (): Promise<string> => Promise.resolve('hash-a')

describe('the plan lifecycle', () => {
  it('passes the gate while the plan is unspent', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'lifecycle-'))
    try {
      await writeFile(join(dir, PLAN_FILE), 'plan bytes', 'utf8')
      await writeFile(join(dir, DEPLOYMENT_STATE_FILE), JSON.stringify(planned()), 'utf8')
      await expect(assertPlanApproved(dir, () => readSnapshotOf(dir), hashA)).resolves.toBeUndefined()
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('asks for a new plan once the records are cleared', async () => {
    // This is the state `terraform_apply` leaves behind on success. Without the
    // clear, the gate would pass and terraform would report "Saved plan is
    // stale" — an error about a file the user never saw.
    const dir = await mkdtemp(join(tmpdir(), 'lifecycle-'))
    try {
      await writeFile(join(dir, DEPLOYMENT_STATE_FILE), JSON.stringify(planned()), 'utf8')
      await clearPlanRecords(dir)
      await writeFile(join(dir, PLAN_FILE), 'plan bytes', 'utf8')
      await expect(assertPlanApproved(dir, () => readSnapshotOf(dir), hashA))
        .rejects.toThrow(/Call terraform_plan again/)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('leaves the file readable after the clear', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'lifecycle-'))
    try {
      await writeFile(join(dir, DEPLOYMENT_STATE_FILE), JSON.stringify(planned()), 'utf8')
      await clearPlanRecords(dir)
      const raw = JSON.parse(await readFile(join(dir, DEPLOYMENT_STATE_FILE), 'utf8')) as DeploymentSnapshot
      expect(raw.status.plan_check).toBeUndefined()
      expect(raw.status.cost_written).toBe(true)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})

/** Read a snapshot for the gate, from the directory it was written to. */
async function readSnapshotOf(dir: string): Promise<DeploymentSnapshot | undefined> {
  try {
    return JSON.parse(await readFile(join(dir, DEPLOYMENT_STATE_FILE), 'utf8')) as DeploymentSnapshot
  } catch {
    return undefined
  }
}

describe('clearPlanRecords', () => {
  it('drops the teardown preview, which describes state that no longer exists', async () => {
    // A preview taken before an apply names resources as the state held them
    // then. Applying moves the state, so the preview is about a world that is
    // gone — and `assertDestroyPreviewed` would still accept it.
    const dir = await mkdtemp(join(tmpdir(), 'lifecycle-'))
    try {
      const snapshot: DeploymentSnapshot = {
        ...planned(),
        status: {
          ...planned().status,
          destroy_check: { tf_hash: 'hash-a', previewed_at: '2026-11-07T00:00:00.000Z', targets: [] },
        },
      }
      await writeFile(join(dir, DEPLOYMENT_STATE_FILE), JSON.stringify(snapshot), 'utf8')
      await clearPlanRecords(dir)
      const after = await readSnapshotOf(dir)
      expect(after?.status.destroy_check).toBeUndefined()
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('keeps the design check, which is still a fact about the .tf', async () => {
    // The design has not changed; only the plan computed from it is spent.
    // Clearing this would demand a re-validation nobody asked for.
    const dir = await mkdtemp(join(tmpdir(), 'lifecycle-'))
    try {
      const snapshot: DeploymentSnapshot = {
        ...planned(),
        status: {
          ...planned().status,
          design_check: { tf_hash: 'hash-a', ok: true, checked_at: '2026-11-07T00:00:00.000Z' },
        },
      }
      await writeFile(join(dir, DEPLOYMENT_STATE_FILE), JSON.stringify(snapshot), 'utf8')
      await clearPlanRecords(dir)
      expect((await readSnapshotOf(dir))?.status.design_check).toEqual({
        tf_hash: 'hash-a', ok: true, checked_at: '2026-11-07T00:00:00.000Z',
      })
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('keeps the status a reader looks at', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'lifecycle-'))
    try {
      const snapshot: DeploymentSnapshot = {
        ...planned(),
        status: { ...planned().status, applied: true, last_operation: 'terraform_apply' },
      }
      await writeFile(join(dir, DEPLOYMENT_STATE_FILE), JSON.stringify(snapshot), 'utf8')
      await clearPlanRecords(dir)
      const after = await readSnapshotOf(dir)
      expect(after?.status.applied).toBe(true)
      expect(after?.status.cost_written).toBe(true)
      expect(after?.status.last_operation).toBe('terraform_apply')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('is a no-op for a directory that holds no snapshot', async () => {
    // A workspace the user pointed at directly. There is nothing recorded to
    // forget, and throwing would fail an apply that had already succeeded.
    const dir = await mkdtemp(join(tmpdir(), 'lifecycle-'))
    try {
      await expect(clearPlanRecords(dir)).resolves.toBeUndefined()
      expect(await readSnapshotOf(dir)).toBeUndefined()
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('restamps the change time, so the snapshot reads as current', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'lifecycle-'))
    try {
      await writeFile(join(dir, DEPLOYMENT_STATE_FILE), JSON.stringify(planned()), 'utf8')
      await clearPlanRecords(dir)
      expect((await readSnapshotOf(dir))?.status.last_operation_at)
        .not.toBe('2026-11-07T00:00:00.000Z')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})

describe('operations that write state invalidate the saved plan', () => {
  it('an import spends the plan, because the state moved', async () => {
    // Verified against terraform: after `state rm`, applying a saved plan fails
    // with "Saved plan is stale / the given plan file can no longer be applied
    // because the state was changed by another operation". An import moves the
    // state the same way, so the plan computed before it describes a different
    // world.
    //
    // `clearPlanRecords` drops the RECORD; deleting the FILE is the tool's job
    // (it owns the workspace). With only the record gone the gate still refuses,
    // which is the property that matters — it cannot pass on a plan whose
    // provenance is unknown.
    const dir = await mkdtemp(join(tmpdir(), 'lifecycle-'))
    try {
      await writeFile(join(dir, PLAN_FILE), 'plan bytes', 'utf8')
      await writeFile(join(dir, DEPLOYMENT_STATE_FILE), JSON.stringify(planned()), 'utf8')
      await clearPlanRecords(dir)
      await expect(assertPlanApproved(dir, () => readSnapshotOf(dir), hashA))
        .rejects.toThrow(/no record of which configuration|Call terraform_plan/)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('a destroy spends the apply plan too, not only its own preview', async () => {
    // A deployment torn down owns nothing, so the change set that built it is
    // about resources that no longer exist. Leaving plan.tfplan with a matching
    // digest would let apply pass every gate and fail on terraform's stale-plan
    // error.
    const dir = await mkdtemp(join(tmpdir(), 'lifecycle-'))
    try {
      const snapshot: DeploymentSnapshot = {
        ...planned(),
        status: {
          ...planned().status,
          applied: true,
          destroyed: true,
          last_operation: 'terraform_destroy',
        },
      }
      await writeFile(join(dir, DEPLOYMENT_STATE_FILE), JSON.stringify(snapshot), 'utf8')
      await clearPlanRecords(dir)
      await expect(assertPlanApproved(dir, () => readSnapshotOf(dir), hashA))
        .rejects.toThrow(/no plan\.tfplan|Call terraform_plan/)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})

describe('ensureDeployment', () => {
  it('returns the snapshot of a directory that is already a deployment', async () => {
    // Re-running create_deployment on a workspace in use is the normal case,
    // not the guarded one. Saying "directory is not empty and not a deployment"
    // about a directory that IS a deployment names the wrong condition.
    const dir = await mkdtemp(join(tmpdir(), 'ensure-'))
    try {
      const first = await ensureDeployment(dir)
      const again = await ensureDeployment(dir)
      expect(again.created_at).toBe(first.created_at)
      expect(again.status.last_operation).toBe('create_deployment')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('still refuses a directory holding unrelated files', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ensure-'))
    try {
      await writeFile(join(dir, 'unrelated.txt'), 'x', 'utf8')
      await expect(ensureDeployment(dir)).rejects.toThrow(/not empty and not a deployment/)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})

describe('reading a state', () => {
  /** A state document with a root resource, one in a module, and one counted. */
  const STATE = {
    format_version: '1.0',
    values: {
      root_module: {
        resources: [
          { address: 'huaweicloud_vpc.prod', type: 'huaweicloud_vpc', values: { cidr: '10.0.0.0/16' } },
          { address: 'huaweicloud_compute_instance.web[0]', type: 'huaweicloud_compute_instance' },
        ],
        child_modules: [{
          address: 'module.net',
          resources: [
            { address: 'huaweicloud_vpc_subnet.web', type: 'huaweicloud_vpc_subnet' },
          ],
        }],
      },
    },
  }

  it('lists addresses and types, not attributes', async () => {
    // The bulk of a state is per-resource attributes — provider defaults nobody
    // asked about. A tool whose job is "which resources are managed here, and
    // what are their addresses" hands back exactly that.
    expect(stateInventory(STATE)).toEqual([
      { address: 'huaweicloud_vpc.prod', type: 'huaweicloud_vpc' },
      { address: 'huaweicloud_compute_instance.web[0]', type: 'huaweicloud_compute_instance' },
      { address: 'module.net.huaweicloud_vpc_subnet.web', type: 'huaweicloud_vpc_subnet', module: 'module.net' },
    ])
  })

  it('returns one resource in full by its address', async () => {
    const found = stateResource(STATE, 'huaweicloud_vpc.prod') as { values?: unknown }
    expect(found.values).toEqual({ cidr: '10.0.0.0/16' })
  })

  it('resolves a module address', async () => {
    expect(stateResource(STATE, 'module.net.huaweicloud_vpc_subnet.web')).toBeDefined()
  })

  it('answers undefined for an address it does not hold', async () => {
    // Nothing is guessed: a near-miss returning a different resource would be
    // worse than no answer, because the caller would act on it.
    expect(stateResource(STATE, 'huaweicloud_vpc.nope')).toBeUndefined()
    expect(stateResource(STATE, 'huaweicloud_vpc')).toBeUndefined()
  })

  it('survives a document that is not a state', async () => {
    expect(stateInventory(null)).toEqual([])
    expect(stateInventory({})).toEqual([])
    expect(stateInventory('nope')).toEqual([])
    expect(stateResource(undefined, 'a.b')).toBeUndefined()
  })
})
