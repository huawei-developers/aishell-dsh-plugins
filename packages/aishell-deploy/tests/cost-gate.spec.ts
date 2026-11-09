/**
 * The apply gate on the cost record.
 *
 * `cost.json` is written by `price_resources` from the BSS rating API, so the
 * gate has two ways a correct record can still be wrong at apply time: absent
 * or empty, and stale. Both are checked here; neither re-prices, because that
 * would make apply depend on a live billing call.
 *
 * The stale case is the one worth keeping. The record carries the digest of the
 * configuration it priced, and a configuration edited afterwards describes
 * something that will not be built — the total on screen and the resources
 * about to be created are different designs.
 */

import { describe, it, expect } from 'vitest'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { runCostGate } from '../src/gates/cost_gate.ts'

/** Write a deployment and run the gate over it. */
async function gate(
  cost: unknown,
  hash: () => Promise<string>,
): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'cost-gate-'))
  try {
    if (cost !== undefined) {
      await writeFile(join(dir, 'cost.json'), JSON.stringify(cost), 'utf8')
    }
    await runCostGate(dir, hash)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

/** A record `price_resources` would write. */
function record(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    currency: 'CNY',
    period: 'month',
    hours: 730,
    priced_at: '2026-11-07T00:00:00.000Z',
    regions: ['cn-north-4'],
    tf_hash: 'hash-a',
    items: [{ address: 'huaweicloud_compute_instance.web', spec: 'c7.large.2.linux', monthly: 312.44 }],
    unpriced: [],
    total_monthly: 312.44,
    ...overrides,
  }
}

const sameHash = (): Promise<string> => Promise.resolve('hash-a')
const otherHash = (): Promise<string> => Promise.resolve('hash-b')

describe('runCostGate', () => {
  it('passes a current record', async () => {
    await expect(gate(record(), sameHash)).resolves.toBeUndefined()
  })

  it('refuses when cost.json is absent', async () => {
    await expect(gate(undefined, sameHash))
      .rejects.toThrow(/Call price_resources/)
  })

  it('refuses a record with no priced item', async () => {
    // An empty cost is not an approved one: applying it spends money that no
    // figure on screen accounted for.
    await expect(gate(record({ items: [], total_monthly: null }), sameHash))
      .rejects.toThrow(/records no priced resource/)
  })

  it('refuses a record with no inquiry timestamp', async () => {
    await expect(gate(record({ priced_at: undefined }), sameHash))
      .rejects.toThrow(/no inquiry timestamp/)
  })

  it('refuses a record that does not say what it priced', async () => {
    // A record from before the digest existed. Re-quoting is the one action
    // that both satisfies the gate and produces a current figure.
    await expect(gate(record({ tf_hash: undefined }), sameHash))
      .rejects.toThrow(/does not record which configuration/)
  })

  it('refuses a configuration edited after it was priced', async () => {
    await expect(gate(record(), otherHash))
      .rejects.toThrow(/changed after they were priced/)
  })

  it('names the remedy for a stale record', async () => {
    await expect(gate(record(), otherHash))
      .rejects.toThrow(/price_resources again/)
  })

  it('refuses a cost.json that is not valid JSON', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'cost-gate-'))
    try {
      await writeFile(join(dir, 'cost.json'), '{ broken', 'utf8')
      await expect(runCostGate(dir, sameHash))
        .rejects.toThrow(/not valid JSON/)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('accepts a record whose unpriced list is not empty', async () => {
    // Unpriced resources are reported by price_resources and the user agrees to
    // the total with them visible. The gate's job is that SOMETHING was priced,
    // not that everything was.
    await expect(gate(record({
      unpriced: [{ address: 'huaweicloud_vpc.prod', reason: 'has no price of its own' }],
    }), sameHash)).resolves.toBeUndefined()
  })
})
describe('runCostGate — a plan with nothing to charge for', () => {
  it('passes a record that states nothing is billable', async () => {
    // A network of VPCs, subnets and security groups costs nothing to create.
    // It has no items either, so without the flag this record would be
    // indistinguishable from "everything went unpriced" — and the deployment
    // could never be applied at all.
    await expect(gate(
      record({ items: [], unpriced: [], total_monthly: null, nothing_billable: true }),
      sameHash,
    )).resolves.toBeUndefined()
  })

  it('still refuses an empty record that claims no such thing', async () => {
    // An older record, or one written where every resource went unpriced: the
    // absence of items is a gap, not an approval.
    await expect(gate(
      record({ items: [], unpriced: [{ address: 'a.b', reason: 'no rule' }], total_monthly: null }),
      sameHash,
    )).rejects.toThrow(/records no priced resource/)
  })

  it('holds a nothing-billable record to the same staleness rule', async () => {
    // The exemption is about what the record SAYS, not about checking it less.
    await expect(gate(
      record({ items: [], unpriced: [], total_monthly: null, nothing_billable: true }),
      otherHash,
    )).rejects.toThrow(/changed after they were priced/)
  })

  it('does not read the flag from a non-boolean', async () => {
    // `"true"` is not the writer's shape, and the gate treats anything but a
    // literal true as absent — the safe direction.
    await expect(gate(
      record({ items: [], unpriced: [], nothing_billable: 'true' }),
      sameHash,
    )).rejects.toThrow(/records no priced resource/)
  })
})
