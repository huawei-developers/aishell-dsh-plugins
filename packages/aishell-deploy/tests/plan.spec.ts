/**
 * Reading a plan into what an approval turns on.
 *
 * The raw plan is megabytes of provider defaults; this reduces it to which
 * resources change and how. Two reductions matter and are pinned here:
 *
 *   - **A replace is not an update.** Terraform encodes it as
 *     `["delete", "create"]`, and reporting that as "update" hides the one fact
 *     a person needs: the data on that resource is going away.
 *   - **An update names its attributes.** The values are in the plan; what a
 *     reviewer needs from a summary is which arguments moved.
 */

import { describe, it, expect } from 'vitest'

import { summarizePlan } from '../src/plan.ts'

/** A plan document with one entry per action worth distinguishing. */
const PLAN = {
  resource_changes: [
    {
      address: 'huaweicloud_vpc.prod',
      change: { actions: ['create'], before: null, after: { name: 'prod', cidr: '10.0.0.0/16' } },
    },
    {
      address: 'huaweicloud_compute_instance.web',
      change: {
        actions: ['delete', 'create'],
        replace_paths: [['image_id'], ['network', 0, 'uuid']],
        before: { image_id: 'old', network: [{ uuid: 'a' }] },
        after: { image_id: 'new', network: [{ uuid: 'b' }] },
      },
    },
    {
      address: 'huaweicloud_vpc_subnet.web',
      change: {
        actions: ['update'],
        before: { name: 'web', cidr: '10.0.1.0/24' },
        after: { name: 'web', cidr: '10.0.2.0/24' },
      },
    },
    {
      address: 'huaweicloud_vpc_subnet.old',
      change: { actions: ['delete'], before: { name: 'old' }, after: null },
    },
    {
      address: 'huaweicloud_vpc_subnet.same',
      change: { actions: ['no-op'], before: { name: 'same' }, after: { name: 'same' } },
    },
  ],
  output_changes: {
    vpc_id: { actions: ['create'] },
    subnet_id: { actions: ['update'] },
  },
}

describe('summarizePlan', () => {
  it('reports a delete-then-create as a replace, not an update', () => {
    // The distinction a person acts on: a replace destroys what is there.
    const summary = summarizePlan(PLAN)!
    const entry = summary.resources.find(resource => resource.address === 'huaweicloud_compute_instance.web')
    expect(entry?.action).toBe('replace')
  })

  it('keeps what forces the replacement, as readable paths', () => {
    const summary = summarizePlan(PLAN)!
    const entry = summary.resources.find(resource => resource.address === 'huaweicloud_compute_instance.web')
    expect(entry?.replacedBecause).toEqual(['image_id', 'network.0.uuid'])
  })

  it('names the attributes an update changes', () => {
    const summary = summarizePlan(PLAN)!
    const entry = summary.resources.find(resource => resource.address === 'huaweicloud_vpc_subnet.web')
    expect(entry?.changes).toEqual(['cidr'])
  })

  it('counts a replace as one create and one destroy, as terraform does', () => {
    // The counts have to agree with terraform's own output, or a reader sees
    // two totals for one plan.
    const summary = summarizePlan(PLAN)!
    expect(summary.counts).toEqual({ create: 2, change: 1, destroy: 2 })
  })

  it('includes a no-op resource with its own action rather than dropping it', () => {
    // Dropping it would make the plan list shorter than the configuration, and
    // a reader counting boxes would come up short without knowing why.
    const summary = summarizePlan(PLAN)!
    expect(summary.resources.map(resource => resource.action)).toContain('no-op')
  })

  it('reads the output changes', () => {
    const summary = summarizePlan(PLAN)!
    expect(summary.outputs).toEqual([
      { name: 'vpc_id', action: 'create' },
      { name: 'subnet_id', action: 'update' },
    ])
  })

  it('returns undefined for a document that is not a plan', () => {
    expect(summarizePlan(null)).toBeUndefined()
    expect(summarizePlan({})).toBeUndefined()
    expect(summarizePlan({ resource_changes: 'nope' })).toBeUndefined()
  })

  it('survives an entry with no address or no actions', () => {
    const summary = summarizePlan({
      resource_changes: [
        { change: { actions: ['create'] } },
        { address: 'a.b' },
        { address: 'c.d', change: { actions: [] } },
      ],
    })!
    expect(summary.resources).toEqual([])
  })

  it('compresses a real plan rather than returning it', () => {
    // A small plan is a few kilobytes; the summary must be a fraction of it, or
    // the tool has not done the reduction it exists for.
    const summary = summarizePlan(PLAN)!
    expect(JSON.stringify(summary).length).toBeLessThan(JSON.stringify(PLAN).length)
  })
})
describe('a destroy preview', () => {
  it('reads as a list of deletions through the same summary', () => {
    // `terraform plan -destroy` writes the same document shape with every action
    // `["delete"]`, so the change list needs no second reader.
    const summary = summarizePlan({
      resource_changes: [
        { address: 'huaweicloud_compute_instance.web', change: { actions: ['delete'] } },
        { address: 'huaweicloud_rds_instance.db', change: { actions: ['delete'] } },
      ],
    })!
    expect(summary.resources.map(resource => resource.action)).toEqual(['destroy', 'destroy'])
    expect(summary.counts).toEqual({ create: 0, change: 0, destroy: 2 })
  })
})
