/**
 * The gate that makes apply run the plan the user was shown.
 *
 * The reason this has to exist at all: `terraform apply <saved-plan>` executes
 * whatever the plan was computed from and does NOT check that the `.tf` still
 * matches. Verified against terraform 1.x — a plan computed before an edit
 * applies without complaint. So the tie between "what the user approved" and
 * "what runs" can only be kept here.
 *
 * Without this gate, `terraform apply` re-plans at apply time: the changes made
 * are computed from the current configuration, which may differ from the one on
 * screen when the user said yes.
 */

import { describe, it, expect } from 'vitest'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { assertDestroyPreviewed, assertPlanApproved, DESTROY_PLAN_FILE, PLAN_FILE } from '../src/gates/plan_gate.ts'
import type { DeploymentSnapshot } from '../src/deployment-state.ts'

/** Run the gate against a deployment holding (or not holding) a plan file. */
async function gate(
  withPlan: boolean,
  snapshot: DeploymentSnapshot | undefined,
  currentHash: () => Promise<string>,
): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'plan-gate-'))
  try {
    if (withPlan) await writeFile(join(dir, PLAN_FILE), 'plan bytes', 'utf8')
    await assertPlanApproved(dir, () => Promise.resolve(snapshot), currentHash)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

/** A snapshot recording a plan of `hash-a`. */
function recorded(tfHash = 'hash-a'): DeploymentSnapshot {
  return {
    created_at: '2026-11-07T00:00:00.000Z',
    created_with: 'aishell-deploy',
    server_version: '0.0.0-test',
    status: {
      cost_written: false,
      applied: false,
      destroyed: false,
      plan_check: {
        tf_hash: tfHash,
        planned_at: '2026-11-07T00:00:00.000Z',
        actions: { create: 2, change: 0, destroy: 0 },
      },
      last_operation: 'terraform_plan',
      last_operation_at: '2026-11-07T00:00:00.000Z',
    },
  }
}

const hashA = (): Promise<string> => Promise.resolve('hash-a')
const hashB = (): Promise<string> => Promise.resolve('hash-b')

describe('assertPlanApproved', () => {
  it('passes a plan computed from the configuration on disk', async () => {
    await expect(gate(true, recorded(), hashA)).resolves.toBeUndefined()
  })

  it('refuses when no plan was ever computed', async () => {
    await expect(gate(false, recorded(), hashA))
      .rejects.toThrow(/Call terraform_plan first/)
  })

  it('refuses a plan file with no record of its configuration', async () => {
    // A plan from before the record existed, or a stray file. Re-planning is the
    // one action that produces both a current plan and its digest.
    const snapshot: DeploymentSnapshot = {
      ...recorded(),
      status: {
        cost_written: false,
        applied: false,
        destroyed: false,
        last_operation: 'create_deployment',
        last_operation_at: '2026-11-07T00:00:00.000Z',
      },
    }
    await expect(gate(true, snapshot, hashA))
      .rejects.toThrow(/no record of which configuration/)
  })

  it('refuses a plan whose configuration has changed since', async () => {
    // The case terraform itself allows: apply would run the old plan silently.
    await expect(gate(true, recorded(), hashB))
      .rejects.toThrow(/changed after the plan was computed/)
  })

  it('names what applying a stale plan would mean', async () => {
    await expect(gate(true, recorded(), hashB))
      .rejects.toThrow(/changes nobody reviewed/)
  })

  it('accepts a record whose counts are absent', async () => {
    // A plan that produced no readable change list still has a digest, and the
    // approval it represents is still valid; the counts are informational.
    const snapshot = recorded()
    const withoutCounts: DeploymentSnapshot = {
      ...snapshot,
      status: {
        ...snapshot.status,
        plan_check: { tf_hash: 'hash-a', planned_at: '2026-11-07T00:00:00.000Z' },
      },
    }
    await expect(gate(true, withoutCounts, hashA)).resolves.toBeUndefined()
  })
})
/**
 * The teardown gate.
 *
 * `terraform destroy -auto-approve` computes its own plan, so the list the user
 * approved and the resources that disappear are two separate computations.
 * Verified: `plan -destroy -target=A -out=f` then `apply f` removes A and
 * leaves B, while `-target` is refused alongside a plan file at apply time. So
 * binding the preview to the destruction is the only way the two match.
 */
describe('assertDestroyPreviewed', () => {
  /** A snapshot recording a teardown preview. */
  function previewed(targets: readonly string[], tfHash = 'hash-a'): DeploymentSnapshot {
    return {
      created_at: '2026-11-07T00:00:00.000Z',
      created_with: 'aishell-deploy',
      server_version: '0.0.0-test',
      status: {
        cost_written: false,
        applied: false,
        destroyed: false,
        destroy_check: {
          tf_hash: tfHash,
          previewed_at: '2026-11-07T00:00:00.000Z',
          targets,
        },
        last_operation: 'terraform_plan_destroy',
        last_operation_at: '2026-11-07T00:00:00.000Z',
      },
    }
  }

  /** Run the gate against a deployment holding (or not holding) a preview. */
  async function gate(
    withPreview: boolean,
    snapshot: DeploymentSnapshot | undefined,
    targets: readonly string[],
    currentHash: () => Promise<string>,
  ): Promise<void> {
    const dir = await mkdtemp(join(tmpdir(), 'destroy-gate-'))
    try {
      if (withPreview) await writeFile(join(dir, DESTROY_PLAN_FILE), 'plan bytes', 'utf8')
      await assertDestroyPreviewed(dir, () => Promise.resolve(snapshot), currentHash, targets)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  }

  it('passes when the preview covers the targets asked for', async () => {
    await expect(gate(true, previewed(['a.b', 'a.c']), ['a.b', 'a.c'], hashA))
      .resolves.toBeUndefined()
  })

  it('passes when a whole-deployment teardown is asked for', async () => {
    await expect(gate(true, previewed([]), [], hashA)).resolves.toBeUndefined()
  })

  it('refuses when nothing was previewed', async () => {
    await expect(gate(false, previewed([]), [], hashA))
      .rejects.toThrow(/Call terraform_plan with destroy: true/)
  })

  it('refuses a preview with no record of what it covered', async () => {
    const snapshot: DeploymentSnapshot = {
      ...previewed([]),
      status: {
        cost_written: false,
        applied: false,
        destroyed: false,
        last_operation: 'create_deployment',
        last_operation_at: '2026-11-07T00:00:00.000Z',
      },
    }
    await expect(gate(true, snapshot, [], hashA))
      .rejects.toThrow(/no record of what was previewed/)
  })

  it('refuses destroying a subset when the whole deployment was previewed', async () => {
    // The dangerous direction: the user approved a full teardown, and a later
    // call asks for one resource. Applying the saved plan would remove
    // everything.
    await expect(gate(true, previewed([]), ['a.b'], hashA))
      .rejects.toThrow(/whole deployment.*a\.b/s)
  })

  it('refuses destroying everything when only a subset was previewed', async () => {
    await expect(gate(true, previewed(['a.b']), [], hashA))
      .rejects.toThrow(/only a\.b.*whole deployment/s)
  })

  it('refuses a preview that covers a different subset', async () => {
    await expect(gate(true, previewed(['a.b']), ['a.c'], hashA))
      .rejects.toThrow(/a\.b.*a\.c/s)
  })

  it('compares targets regardless of the order they were given in', async () => {
    await expect(gate(true, previewed(['a.b', 'a.c']), ['a.c', 'a.b'], hashA))
      .resolves.toBeUndefined()
  })

  it('refuses a preview computed from a configuration that has changed', async () => {
    // Every other gate works this way, and a destroy is the least reversible
    // of them.
    await expect(gate(true, previewed(['a.b']), ['a.b'], hashB))
      .rejects.toThrow(/changed after the teardown was previewed/)
  })
})
