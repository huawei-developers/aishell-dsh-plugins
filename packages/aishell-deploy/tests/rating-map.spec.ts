/**
 * Turning a terraform resource into a BSS inquiry.
 *
 * Every mapping here was established against the live catalogue and the rating
 * API, and each one is a case where the obvious value answers with a
 * misleading error:
 *
 *   - a bare `c7.large.2` answers `CBC.99006006 Product not found`; the API's
 *     own contract says to append `.linux` or `.win`;
 *   - `hws.resource.type.rds` answers `CBC.6074`, the code that otherwise means
 *     "not sold to this account", while the instance bills under `…rds.vm`;
 *   - a DCS instance is sold by capacity, so the spec alone is not the product.
 *
 * The tables are pinned here so a future tidy-up cannot quietly simplify them.
 */

import { describe, it, expect } from 'vitest'

import {
  DURATION_FACTOR,
  HOURS_PER_MONTH,
  SIZE_MEASURE_GB,
  chooseResourceType,
  platformSuffixOf,
  ratingRuleFor,
} from '../src/rating-map.ts'

describe('ratingRuleFor', () => {
  it('maps the priced resource types to their BSS service', () => {
    expect(ratingRuleFor('huaweicloud_compute_instance')?.serviceType).toBe('hws.service.type.ec2')
    expect(ratingRuleFor('huaweicloud_rds_instance')?.serviceType).toBe('hws.service.type.rds')
    expect(ratingRuleFor('huaweicloud_dcs_instance')?.serviceType).toBe('hws.service.type.dcs')
    // `ebs`, not `evs`: the catalogue lists 云硬盘 under `hws.service.type.ebs`.
    expect(ratingRuleFor('huaweicloud_evs_volume')?.serviceType).toBe('hws.service.type.ebs')
    // An EIP bills under VPC, not a service of its own.
    expect(ratingRuleFor('huaweicloud_vpc_eip')?.serviceType).toBe('hws.service.type.vpc')
  })

  it('says nothing about a resource that has no price of its own', () => {
    expect(ratingRuleFor('huaweicloud_vpc')).toBeUndefined()
    expect(ratingRuleFor('huaweicloud_vpc_subnet')).toBeUndefined()
  })

  it('maps the services whose specs were established from the catalogue', () => {
    // Each answers the catalogue's spec query, and each spec below prices
    // through the rating API — which is what makes the rule worth having.
    expect(ratingRuleFor('huaweicloud_nat_gateway')?.serviceType).toBe('hws.service.type.natgateway')
    expect(ratingRuleFor('huaweicloud_nat_gateway')?.specAttributes).toEqual(['spec'])

    expect(ratingRuleFor('huaweicloud_elb_loadbalancer')?.serviceType).toBe('hws.service.type.elb')
    expect(ratingRuleFor('huaweicloud_elb_loadbalancer')?.fixedSpec).toBe('elbv2.basic.default')
    // The dedicated line (`elbv3`) offers specs without an on-demand billing
    // item, so the shared form's resource type is what the rule must name.
    expect(ratingRuleFor('huaweicloud_elb_loadbalancer')?.resourceTypeHint).toBe('elbv2')

    expect(ratingRuleFor('huaweicloud_apig_instance')?.serviceType).toBe('hws.service.type.apig')
    expect(ratingRuleFor('huaweicloud_apig_instance')?.upperCaseSpec).toBe(true)

    expect(ratingRuleFor('huaweicloud_vpcep_endpoint')?.fixedSpec).toBe('vpcep.basic')
  })

  it('says nothing about OBS, which is sold on two dimensions at once', () => {
    // A bucket's bill has a storage component and a request component, and the
    // rating API prices one spec per product. Classifying it would quote one
    // of the two and present it as the cost.
    expect(ratingRuleFor('huaweicloud_obs_bucket')).toBeUndefined()
  })

  it('reads the spec from the attribute the provider actually uses', () => {
    // The provider is not consistent: compute takes flavor_id, a managed
    // database takes flavor.
    expect(ratingRuleFor('huaweicloud_compute_instance')?.specAttributes).toContain('flavor_id')
    expect(ratingRuleFor('huaweicloud_rds_instance')?.specAttributes).toEqual(['flavor'])
    expect(ratingRuleFor('huaweicloud_dcs_instance')?.specAttributes).toEqual(['flavor'])
  })

  it('marks only compute as needing an OS suffix', () => {
    expect(ratingRuleFor('huaweicloud_compute_instance')?.platformSuffix).toBe(true)
    expect(ratingRuleFor('huaweicloud_rds_instance')?.platformSuffix).toBeUndefined()
  })

  it('reads an EIP from its nested blocks', () => {
    // The provider puts the charge mode in `publicip.type` and the size in
    // `bandwidth.size`; reading only top-level attributes finds neither, and
    // the resource is reported as unpriced.
    const rule = ratingRuleFor('huaweicloud_vpc_eip')!
    expect(rule.attributeBlock).toBe('publicip')
    expect(rule.specAttribute).toBe('type')
    expect(rule.capacityBlock).toBe('bandwidth')
    expect(rule.capacityAttribute).toBe('size')
    expect(chooseResourceType(rule, ['hws.resource.type.ip', 'hws.resource.type.bandwidth']))
      .toBe('hws.resource.type.ip')
  })

  it('marks the resources sold by capacity', () => {
    expect(ratingRuleFor('huaweicloud_dcs_instance')?.capacityAttribute).toBe('capacity')
    expect(ratingRuleFor('huaweicloud_evs_volume')?.capacityAttribute).toBe('size')
  })
})

describe('chooseResourceType', () => {
  /** The codes the live catalogue returned for each service. */
  const CATALOGUE = {
    ec2: ['hws.resource.type.vm', 'hws.resource.type.vm.image', 'hws.resource.type.vm.offline', 'hws.resource.type.cr'],
    rds: ['hws.resource.type.rds.vm', 'hws.resource.type.rds.volume', 'hws.resource.type.rds.license'],
    dcs: ['hws.resource.type.dcs.memcached', 'hws.resource.type.dcs2', 'hws.resource.type.dcs'],
  } as const

  it('picks the instance code for compute, not an image or offline variant', () => {
    const rule = ratingRuleFor('huaweicloud_compute_instance')!
    expect(chooseResourceType(rule, CATALOGUE.ec2)).toBe('hws.resource.type.vm')
  })

  it('picks the instance VM for RDS, not the volume or licence', () => {
    const rule = ratingRuleFor('huaweicloud_rds_instance')!
    expect(chooseResourceType(rule, CATALOGUE.rds)).toBe('hws.resource.type.rds.vm')
  })

  it('picks the service code itself when it is one of the entries', () => {
    // DCS sells `dcs.memcached`, `dcs2` and `dcs`; the instance shapes bill
    // under the plain `dcs`.
    const rule = ratingRuleFor('huaweicloud_dcs_instance')!
    expect(chooseResourceType(rule, CATALOGUE.dcs)).toBe('hws.resource.type.dcs')
  })

  it('returns undefined when the catalogue carries nothing that fits', () => {
    // The product is not sold in this region, which is a fact to report rather
    // than a code to invent.
    const rule = ratingRuleFor('huaweicloud_rds_instance')!
    expect(chooseResourceType(rule, ['hws.resource.type.somethingelse'])).toBeUndefined()
  })
})

describe('platformSuffixOf', () => {
  it('classifies a Windows image', () => {
    expect(platformSuffixOf('Windows Server 2019 Standard 64bit')).toBe('windows')
  })

  it('classifies the public Linux distributions', () => {
    for (const name of [
      'Huawei Cloud EulerOS 3.0 Standard 64 bit',
      'Ubuntu 22.04 server 64bit',
      'CentOS 8.2 64bit',
      'Debian 12.0 64bit',
    ]) {
      expect(platformSuffixOf(name), name).toBe('linux')
    }
  })

  it('returns undefined rather than defaulting to Linux', () => {
    // A default would price a Windows instance at Linux rates whenever the image
    // name was unfamiliar — a wrong number, not a reported gap.
    expect(platformSuffixOf('Some Future OS 1.0')).toBeUndefined()
    expect(platformSuffixOf(undefined)).toBeUndefined()
  })
})

describe('the constants the inquiry uses', () => {
  it('prices a month of hours', () => {
    expect(HOURS_PER_MONTH).toBe(730)
    expect(DURATION_FACTOR).toBe('Duration')
  })

  it('measures capacity in GB', () => {
    expect(SIZE_MEASURE_GB).toBe(17)
  })
})
describe('the spec catalogue is not the set of priceable specs', () => {
  it('has a rule whose spec is built rather than listed', () => {
    // Compute prices `c7.large.2.linux` — the flavour with the OS suffix the
    // billing variant needs — and the catalogue enumerates flavours WITHOUT
    // that suffix, so the priceable code appears in no entry. Verified: the
    // suffixed spec prices at 312.44 CNY/month while the list carries
    // `ac6.12xlarge.2.linux` and no `c7.large.2.linux`.
    //
    // The consequence is a design constraint: a membership test against the
    // catalogue may only guard the rules that NAME their spec outright, never
    // one whose spec is composed from the plan.
    const compute = ratingRuleFor('huaweicloud_compute_instance')!
    expect(compute.platformSuffix).toBe(true)
    expect(compute.fixedSpec).toBeUndefined()
  })

  it('reserves the catalogue check for rules that name their spec', () => {
    // Those are the ones the plan cannot correct: if the region does not sell
    // the named product, nothing in the configuration says otherwise.
    for (const type of ['huaweicloud_elb_loadbalancer', 'huaweicloud_vpcep_endpoint']) {
      expect(ratingRuleFor(type)?.fixedSpec, type).toBeDefined()
    }
    for (const type of ['huaweicloud_compute_instance', 'huaweicloud_rds_instance', 'huaweicloud_nat_gateway']) {
      expect(ratingRuleFor(type)?.fixedSpec, type).toBeUndefined()
    }
  })
})
