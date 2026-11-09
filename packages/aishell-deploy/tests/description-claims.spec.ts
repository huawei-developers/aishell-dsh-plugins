/**
 * What the tools tell the model, checked against what they do.
 *
 * A tool description is a claim about behaviour, and the model acts on it. A
 * description that understates coverage is the dangerous direction: the model
 * reads it, concludes a resource is unpriced, and tells the user so — while the
 * call that would have quoted it is never made. Nothing fails; the bill is just
 * reported as absent.
 *
 * So the facts a description states about coverage are pinned to the source of
 * truth here. These are not prose tests; each asserts one enumerated fact.
 */

import { describe, it, expect } from 'vitest'

import { ratingRuleFor } from '../src/rating-map.ts'

/** The types `price_resources` claims in its description. */
const CLAIMED_PRICED = [
  'huaweicloud_compute_instance',
  'huaweicloud_rds_instance',
  'huaweicloud_dcs_instance',
  'huaweicloud_evs_volume',
  'huaweicloud_vpc_eip',
  'huaweicloud_nat_gateway',
  'huaweicloud_elb_loadbalancer',
  'huaweicloud_apig_instance',
  'huaweicloud_vpcep_endpoint',
]

/** Types the description names as unpriced. */
const CLAIMED_UNPRICED = [
  'huaweicloud_obs_bucket',
  'huaweicloud_vpc',
  'huaweicloud_vpc_subnet',
  'huaweicloud_networking_secgroup',
]

describe('the pricing coverage a tool description promises', () => {
  it('has a rating rule for every type it says is priced', () => {
    for (const type of CLAIMED_PRICED) {
      expect(ratingRuleFor(type), type).toBeDefined()
    }
  })

  it('has no rating rule for the types it says are unpriced', () => {
    // The other direction, and the one that costs the user money: a type the
    // description calls unpriced but the table prices makes the model
    // under-report a bill.
    for (const type of CLAIMED_UNPRICED) {
      expect(ratingRuleFor(type), type).toBeUndefined()
    }
  })
})