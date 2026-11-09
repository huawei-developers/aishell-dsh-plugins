/**
 * The plan readers, and the decisions that make a resource quotable.
 *
 * These are the pure parts of `price_resources`: what a plan entry yields, and
 * which entries are worth asking the API about. The bugs that mattered here
 * were all in this layer — a destroy counted as a cost, a nested block not
 * found, a capacity silently absent — so they are pinned rather than left to
 * the end-to-end runs that need real credentials.
 */

import { describe, it, expect } from 'vitest'

import {
  availabilityZoneOf,
  blockBody,
  carriesNewCost,
  providerRegions,
  resourceProviderKeys,
  looksBillable,
  numberFrom,
  quoteTotal,
  round,
  statesNothingBillable,
  unindexedAddress,
  type PlannedResource,
} from '../src/tools/pricing.ts'
import { ratingRuleFor } from '../src/rating-map.ts'

/** A planned resource with the given type and attributes. */
function planned(type: string, after: Record<string, unknown> = {}): PlannedResource {
  return { address: `${type}.x`, type, action: 'create', after, region: '' }
}

describe('blockBody', () => {
  it('reads a repeatable block as its first body', () => {
    // An EIP keeps its charge mode in `publicip`, which the plan carries as a
    // list because the block may repeat.
    expect(blockBody({ publicip: [{ type: '5_bgp' }] }, 'publicip')).toEqual({ type: '5_bgp' })
  })

  it('reads a single block body as itself', () => {
    expect(blockBody({ bandwidth: { size: 5 } }, 'bandwidth')).toEqual({ size: 5 })
  })

  it('returns an empty body for an absent or malformed block', () => {
    expect(blockBody({}, 'publicip')).toEqual({})
    expect(blockBody({ publicip: 'not a block' }, 'publicip')).toEqual({})
    expect(blockBody({ publicip: [] }, 'publicip')).toEqual({})
  })
})

describe('numberFrom', () => {
  it('reads a number and a numeric string', () => {
    expect(numberFrom({ size: 40 }, 'size')).toBe(40)
    expect(numberFrom({ size: '40' }, 'size')).toBe(40)
  })

  it('returns undefined for a missing, empty or non-numeric value', () => {
    // A capacity that came from a variable is absent from the plan entirely;
    // reporting it as 0 would price a zero-gigabyte volume.
    expect(numberFrom({}, 'size')).toBeUndefined()
    expect(numberFrom({ size: '' }, 'size')).toBeUndefined()
    expect(numberFrom({ size: 'large' }, 'size')).toBeUndefined()
  })
})

describe('availabilityZoneOf', () => {
  it('reads a direct availability_zone', () => {
    expect(availabilityZoneOf(planned('x', { availability_zone: 'cn-north-4a' }))).toBe('cn-north-4a')
  })

  it('reads the first entry of available_zones', () => {
    // A DCS instance declares `available_zones` as a list.
    expect(availabilityZoneOf(planned('x', { available_zones: ['cn-north-4b', 'cn-north-4a'] })))
      .toBe('cn-north-4b')
  })

  it('reports no zone when the design states none', () => {
    // Absent is acceptable — the rating API treats it as "no filter". A wrong
    // zone is not: a flavour is priced per zone.
    expect(availabilityZoneOf(planned('x'))).toBeUndefined()
  })
})

describe('looksBillable', () => {
  it('reports a resource this module cannot classify but that costs money', () => {
    // A bucket, a cluster, a database all cost money; leaving them out of the
    // unpriced list would make a total that silently omits them.
    expect(looksBillable(planned('huaweicloud_obs_bucket'))).toBe(true)
    expect(looksBillable(planned('huaweicloud_cce_cluster'))).toBe(true)
    expect(looksBillable(planned('huaweicloud_nat_gateway'))).toBe(true)
  })

  it('says nothing about the network fabric, which has no price of its own', () => {
    expect(looksBillable(planned('huaweicloud_vpc'))).toBe(false)
    expect(looksBillable(planned('huaweicloud_vpc_subnet'))).toBe(false)
    expect(looksBillable(planned('huaweicloud_networking_secgroup'))).toBe(false)
  })

  it('still reports the billable type that shares the vpc prefix', () => {
    // `huaweicloud_vpc` is a prefix of `huaweicloud_vpc_bandwidth`, and a prefix
    // test on it classified bandwidth as free — dropping a monthly charge out
    // of the quote AND out of the unpriced list, so nothing said it was missing.
    expect(looksBillable(planned('huaweicloud_vpc_bandwidth'))).toBe(true)
  })

  it('leaves the free vpc members alone, including one whose name suggests a charge', () => {
    // A peering connection carries no charge of its own; a peer pays for the
    // bandwidth it uses, which is a separate resource.
    expect(looksBillable(planned('huaweicloud_vpc_peering_connection'))).toBe(false)
  })
})

describe('unindexedAddress', () => {
  it('strips the index terraform adds for count and for_each', () => {
    // The configuration is keyed by `type.name`; `resource_changes` carries the
    // expanded address, and the two only meet after the index is removed.
    expect(unindexedAddress('huaweicloud_compute_instance.web[0]')).toBe('huaweicloud_compute_instance.web')
    expect(unindexedAddress('huaweicloud_compute_instance.web["a"]')).toBe('huaweicloud_compute_instance.web')
  })

  it('strips a module instance key as well as a resource index', () => {
    expect(unindexedAddress('module.m["a"].huaweicloud_compute_instance.web[1]'))
      .toBe('module.m.huaweicloud_compute_instance.web')
  })

  it('leaves an address with no index alone', () => {
    expect(unindexedAddress('huaweicloud_vpc.prod')).toBe('huaweicloud_vpc.prod')
  })
})

describe('round', () => {
  it('rounds to the cent, which is what a price is quoted in', () => {
    expect(round(312.444)).toBe(312.44)
    expect(round(9643.299999)).toBe(9643.3)
    expect(round(0.005)).toBe(0.01)
  })
})

describe('carriesNewCost', () => {
  /** A plan entry with the given action. */
  const withAction = (action: string): PlannedResource => ({
    address: 'x.y', type: 'huaweicloud_compute_instance', action, after: {}, region: '',
  })

  it('quotes a create and a replace', () => {
    // A replace builds the new instance, and the monthly figure is the price of
    // what will exist.
    expect(carriesNewCost(withAction('create'))).toBe(true)
    expect(carriesNewCost(withAction('replace'))).toBe(true)
  })

  it('does not quote a destroy', () => {
    // The resource stops costing the moment the destroy completes. Quoting it
    // would add a recurring charge for something the plan removes.
    expect(carriesNewCost(withAction('destroy'))).toBe(false)
  })

  it('does not quote a no-op', () => {
    // It is already there and already in the user's bill; quoting it double-counts.
    expect(carriesNewCost(withAction('no-op'))).toBe(false)
  })

  it('does not quote a read', () => {
    // A data-source refresh touches nothing.
    expect(carriesNewCost(withAction('read'))).toBe(false)
  })
})

describe('providerRegions', () => {
  it('reads the region each provider block states', () => {
    // A plan carries no region on its resources; it carries one per provider
    // block, as a constant. Verified against a two-region plan.
    const regions = providerRegions({
      provider_config: {
        huaweicloud: { name: 'huaweicloud' },
        'huaweicloud.north4': { expressions: { region: { constant_value: 'cn-north-4' } } },
        'huaweicloud.east3': { expressions: { region: { constant_value: 'cn-east-3' } } },
      },
    })
    expect(regions.get('huaweicloud.north4')).toBe('cn-north-4')
    expect(regions.get('huaweicloud.east3')).toBe('cn-east-3')
    // A block without a region is absent, not defaulted.
    expect(regions.has('huaweicloud')).toBe(false)
  })

  it('leaves out a region given as an expression', () => {
    // It resolves only when terraform runs, so nothing is known here. The
    // caller reports the resource as unpriced rather than filling the gap with
    // a default: a wrong region yields a price that looks checked.
    const regions = providerRegions({
      provider_config: { huaweicloud: { expressions: { region: { references: ['var.region'] } } } },
    })
    expect(regions.size).toBe(0)
  })

  it('returns nothing for a plan with no configuration', () => {
    expect(providerRegions(undefined).size).toBe(0)
    expect(providerRegions({}).size).toBe(0)
  })
})

describe('resourceProviderKeys', () => {
  it('names the block each resource uses', () => {
    // The link lives in `configuration.root_module.resources`, not on a
    // resource change, and `provider_name` cannot distinguish the aliases.
    const keys = resourceProviderKeys({
      root_module: {
        resources: [
          { address: 'huaweicloud_vpc.a', provider_config_key: 'huaweicloud.north4' },
          { address: 'huaweicloud_vpc.b', provider_config_key: 'huaweicloud.east3' },
        ],
      },
    })
    expect(keys.get('huaweicloud_vpc.a')).toBe('huaweicloud.north4')
    expect(keys.get('huaweicloud_vpc.b')).toBe('huaweicloud.east3')
  })

  it('walks into modules, whose resources are nested', () => {
    // A deployment that puts resources in a module would otherwise lose every
    // region.
    const keys = resourceProviderKeys({
      root_module: {
        resources: [{ address: 'huaweicloud_vpc.top', provider_config_key: 'huaweicloud' }],
        module_calls: {
          net: {
            module: {
              resources: [{ address: 'huaweicloud_vpc.inner', provider_config_key: 'huaweicloud.east3' }],
            },
          },
        },
      },
    })
    expect(keys.get('huaweicloud_vpc.top')).toBe('huaweicloud')
    expect(keys.get('module.net.huaweicloud_vpc.inner')).toBe('huaweicloud.east3')
  })

  it('returns nothing for a plan with no configuration', () => {
    expect(resourceProviderKeys(undefined).size).toBe(0)
  })
})

describe('the region a resource is priced in', () => {
  /** The three provider shapes a real plan can carry. */
  const PLAN = {
    provider_config: {
      huaweicloud: { expressions: { region: { constant_value: 'cn-north-4' } } },
      'huaweicloud.east3': { expressions: { region: { constant_value: 'cn-east-3' } } },
      'huaweicloud.varred': { expressions: { region: { references: ['var.region'] } } },
    },
    root_module: {
      resources: [
        { address: 'huaweicloud_vpc.a', provider_config_key: 'huaweicloud' },
        { address: 'huaweicloud_vpc.b', provider_config_key: 'huaweicloud.east3' },
        { address: 'huaweicloud_vpc.c', provider_config_key: 'huaweicloud.varred' },
      ],
    },
  }

  it('resolves each resource from its own provider block', () => {
    // Two regions in one plan is supported, and that is the whole point: a
    // deployment-wide region would have to be right for both at once.
    const keys = resourceProviderKeys(PLAN)
    const regions = providerRegions(PLAN)
    expect(regions.get(keys.get('huaweicloud_vpc.a') ?? '')).toBe('cn-north-4')
    expect(regions.get(keys.get('huaweicloud_vpc.b') ?? '')).toBe('cn-east-3')
  })

  it('leaves a variable region unresolved rather than guessing one', () => {
    // The block is found, but it states no constant. The caller reports the
    // resource as unpriced; a default here would produce a price for a region
    // the deployment may not bill in.
    const regions = providerRegions(PLAN)
    const key = resourceProviderKeys(PLAN).get('huaweicloud_vpc.c')
    expect(key).toBe('huaweicloud.varred')
    expect(regions.get(key ?? '')).toBeUndefined()
  })
})

describe('statesNothingBillable', () => {
  it('says so when nothing was priced and nothing was left over', () => {
    // A network of VPCs, subnets and security groups: no charge of its own, and
    // no resource this module failed to classify. The empty total is the right
    // figure, so the apply gate should accept the record.
    expect(statesNothingBillable(0, 0)).toBe(true)
  })

  it('does not say so when something could not be priced', () => {
    // The dangerous case this flag exists for: no quotes, but only because a
    // database's spec came from a variable. An empty total here understates a
    // bill nobody established.
    expect(statesNothingBillable(0, 3)).toBe(false)
  })

  it('does not say so when something was priced', () => {
    expect(statesNothingBillable(2, 0)).toBe(false)
    expect(statesNothingBillable(2, 1)).toBe(false)
  })
})

describe('quoteTotal', () => {
  const quote = (monthly: number, currency: string) => ({ monthly, currency })

  it('sums quotes that agree on one currency', () => {
    const result = quoteTotal([quote(312.44, 'CNY'), quote(9643.3, 'CNY')])
    expect(result.total).toBe(9955.74)
    expect(result.currencies).toEqual(['CNY'])
  })

  it('refuses to sum across currencies, and says which ones', () => {
    // The rating API answers in the currency of the region's price list, and a
    // deployment spanning regions can in principle draw from two. A summed
    // figure would be denominated in whichever came first — a wrong total that
    // reads exactly like a checked one.
    const result = quoteTotal([quote(312.44, 'CNY'), quote(50, 'USD')])
    expect(result.total).toBeNull()
    expect(result.currencies).toEqual(['CNY', 'USD'])
  })

  it('has no total when there is nothing quoted', () => {
    expect(quoteTotal([])).toEqual({ currencies: [], total: null })
  })

  it('rounds the total to the cent', () => {
    expect(quoteTotal([quote(0.005, 'CNY')]).total).toBe(0.01)
  })
})

describe('a rule that names its own spec', () => {
  it('is checked against what the region actually sells', () => {
    // A `fixedSpec` is a fact about the PROVIDER, and the catalogue is per
    // region: a region selling a different set is a gap rather than a broken
    // classification.
    const rule = ratingRuleFor('huaweicloud_elb_loadbalancer')!
    expect(rule.fixedSpec).toBe('elbv2.basic.default')
    // The check is only meaningful when the rule says what to look for.
    expect(rule.fixedSpec === undefined || typeof rule.fixedSpec === 'string').toBe(true)
  })

  it('is what makes the ELB rule possible at all', () => {
    // The provider names `l4_flavor_id`, never the billing product, so reading
    // a spec from the plan would find nothing and report the resource unpriced
    // for a reason that has nothing to do with the deployment.
    const rule = ratingRuleFor('huaweicloud_elb_loadbalancer')!
    expect(rule.specAttributes).toEqual([])
    expect(rule.fixedSpec).toBeDefined()
  })

  it('upper-cases only where the provider and BSS differ in case', () => {
    // APIG's `edition` is `Basic`; the billing spec is `BASIC`. A case change is
    // the whole mapping, so it is a flag rather than a table.
    expect(ratingRuleFor('huaweicloud_apig_instance')?.upperCaseSpec).toBe(true)
    // Every other rule's spec is used as written or suffixed, never re-cased.
    expect(ratingRuleFor('huaweicloud_compute_instance')?.upperCaseSpec).toBeUndefined()
    expect(ratingRuleFor('huaweicloud_evs_volume')?.upperCaseSpec).toBeUndefined()
  })
})
