/**
 * Deriving an account's topology from what the inventory reports.
 *
 * Two rules are under test, and keeping them apart is the point of the module:
 * **association** needs no vocabulary (an id is an id), while **location** is
 * the network picture's own vocabulary — `vpc`, `subnet`, and nothing else.
 *
 * The wrong answers the location rule excludes are pinned below, one per rule:
 * a server drawn inside its VPC instead of its subnet, a listener drawn inside
 * a security group, and a reference the inventory ships JSON-encoded so a plain
 * string comparison never matches it.
 */

import { describe, it, expect } from 'vitest'

import {
  deriveInventoryTopology,
  flattenProperties,
  locationRank,
} from '../src/existing-topology.ts'

/** A resource, with only the fields the derivation reads. */
function resource(
  id: string,
  provider: string,
  type: string,
  properties: Record<string, unknown> = {},
  name?: string,
) {
  return { id, provider, type, properties, ...(name === undefined ? {} : { name }) }
}

/** The container a node was placed in, as reported by the picture. */
function parentOfNode(
  topology: ReturnType<typeof deriveInventoryTopology>,
  id: string,
): string | undefined {
  return topology.nodes.find(node => node.id === id)?.parent
}

describe('flattenProperties', () => {
  it('reads ids however deeply the provider nests them', () => {
    // Real shapes: a VPN's vpc under `vnic`, a bandwidth's EIP under
    // `publicipInfo`, a security rule's group inside an array of blocks.
    const flat = flattenProperties({
      vnic: { vpcId: 'vpc-1' },
      publicipInfo: { publicipId: 'eip-1' },
      security_group_rules: [{ remote_group_id: 'sg-1' }, { remote_group_id: 'sg-1' }],
    })
    expect(flat.get('vnic.vpcId')).toBe('vpc-1')
    expect(flat.get('publicipInfo.publicipId')).toBe('eip-1')
    // An array collapses to one path: the rule block repeating does not make a
    // second relationship.
    expect(flat.get('security_group_rules.remote_group_id')).toBe('sg-1')
  })

  it('keeps numbers and booleans, which some ids arrive as', () => {
    const flat = flattenProperties({ port: 5432, enabled: true, nothing: null })
    expect(flat.get('port')).toBe('5432')
    expect(flat.get('enabled')).toBe('true')
    expect(flat.has('nothing')).toBe(false)
  })

  it('opens a JSON-encoded id, which RDS ships as a string', () => {
    // Measured on a live account: RDS reports `vpcId` as `"[\"73e7…\"]"` and its
    // subnet as `networkId`. Both are real references; a plain string compare
    // matched neither, so the instance floated at the root with its VPC visible
    // in its own properties.
    const flat = flattenProperties({
      vpcId: '["73e76381-c33b-46bc-975d-755e4f4f1190"]',
      networkId: '["0e2714fd-3ec5-45ac-b89b-ba2235999af1"]',
    })
    expect(flat.get('vpcId')).toBe('73e76381-c33b-46bc-975d-755e4f4f1190')
    expect(flat.get('networkId')).toBe('0e2714fd-3ec5-45ac-b89b-ba2235999af1')
  })

  it('leaves a string that merely looks like JSON alone', () => {
    // A name, a CIDR and a truncated payload all stay what they are — opening
    // them would rewrite a value nothing asked to have rewritten.
    const flat = flattenProperties({
      name: '[not json',
      cidr: '172.16.0.0/12',
      broken: '{"unterminated":',
    })
    expect(flat.get('name')).toBe('[not json')
    expect(flat.get('cidr')).toBe('172.16.0.0/12')
    expect(flat.get('broken')).toBe('{"unterminated":')
  })
})

describe('locationRank', () => {
  it('names a location from the attribute regardless of spelling', () => {
    // The provider writes all of these; a rule demanding one spelling would
    // miss the others.
    for (const attribute of ['vpcId', 'vpc_id', 'clusterVpcId', 'vnic.vpcId', 'vpc_uuid']) {
      expect(locationRank(attribute), attribute).toBe(1)
    }
  })

  it('names a subnet however the service spells it', () => {
    // The provider uses at least four spellings, and a rule that demanded one
    // would place only the services that happened to use it. Every one of
    // these is a live field, checked against a 49-resource account.
    for (const attribute of ['subnetId', 'subnet_id', 'virsubnet_id', 'elb_virsubnet_ids', 'networkId']) {
      expect(locationRank(attribute), attribute).toBe(2)
    }
  })

  it('treats a security group as an association, not a location', () => {
    // The degree rule made this a container, and a listener that names only a
    // security group was drawn inside it.
    expect(locationRank('security_group_id')).toBe(0)
    expect(locationRank('securityGroup.id')).toBe(0)
  })

  it('treats a peer reference as no location at all', () => {
    for (const attribute of ['bandwidth.id', 'publicipInfo.publicipId', 'remote_group_id']) {
      expect(locationRank(attribute), attribute).toBe(0)
    }
  })
})

describe('deriveInventoryTopology', () => {
  it('makes every resource a node, with no type filter', () => {
    // A picture that hides things needs a reason, and "important" is a table by
    // another name. Five resources of four services, none of which this module
    // knows anything about.
    const topology = deriveInventoryTopology([
      resource('vpc-1', 'vpc', 'vpcs', { cidr: '10.0.0.0/16' }, 'prod'),
      resource('sub-1', 'vpc', 'subnets', { vpcId: 'vpc-1' }, 'web'),
      resource('srv-1', 'ecs', 'cloudservers', { vnic: { vpcId: 'vpc-1' } }, 'app'),
      resource('db-1', 'rds', 'instances', { vpcId: 'vpc-1' }, 'db'),
      resource('x-1', 'brandnew', 'widgets', {}, 'mystery'),
    ])
    expect(topology.nodes).toHaveLength(5)
    expect(topology.roots.map(node => node.id).sort()).toEqual(['vpc-1', 'x-1'])
  })

  it('places a workload in its subnet, not in the VPC that holds them both', () => {
    // The three-level picture any account with subnets has. A server names both
    // its subnet and its VPC; naming the subnet is the more specific answer.
    const topology = deriveInventoryTopology([
      resource('vpc-1', 'vpc', 'vpcs', {}, 'prod'),
      resource('sub-1', 'vpc', 'subnets', { vpcId: 'vpc-1' }, 'web'),
      resource('srv-1', 'ecs', 'cloudservers', { subnetId: 'sub-1', vnic: { vpcId: 'vpc-1' } }, 'app'),
    ])
    expect(parentOfNode(topology, 'sub-1')).toBe('vpc-1')
    expect(parentOfNode(topology, 'srv-1')).toBe('sub-1')
    // ...and the chain is what "where does this live" means.
    expect(topology.nodes.find(node => node.id === 'srv-1')?.ancestors).toEqual(['sub-1', 'vpc-1'])
  })

  it('does not place a resource inside a security group', () => {
    // A listener that names only a security group. Nesting it would say the
    // listener lives inside the group, which is not a thing.
    const topology = deriveInventoryTopology([
      resource('sg-1', 'vpc', 'securityGroups', {}, 'sg-api'),
      resource('lis-1', 'elb', 'listeners', { security_group_id: 'sg-1' }, 'https'),
    ])
    expect(parentOfNode(topology, 'lis-1')).toBeUndefined()
    // The relationship is still drawn — as an arrow, which is what it is.
    expect(topology.edges).toEqual([
      { from: 'lis-1', to: 'sg-1', attribute: 'security_group_id', contains: false },
    ])
  })

  it('places an RDS instance in its subnet, both ids JSON-encoded', () => {
    // The measured shape on a live account: RDS ships `vpcId` and `networkId`
    // both wrapped in a JSON array. `networkId` is its subnet — the id matches
    // the VPC API's subnet list — so the instance lands two levels down, which
    // is where it is.
    const topology = deriveInventoryTopology([
      resource('vpc-1', 'vpc', 'vpcs', {}, 'prod'),
      resource('sub-1', 'vpc', 'subnets', { vpcId: 'vpc-1' }, 'web'),
      resource('db-1', 'rds', 'instances', {
        vpcId: '["vpc-1"]',
        networkId: '["sub-1"]',
      }, 'db'),
    ])
    expect(parentOfNode(topology, 'db-1')).toBe('sub-1')
    expect(topology.nodes.find(node => node.id === 'db-1')?.ancestors).toEqual(['sub-1', 'vpc-1'])
  })

  it('places an ELB in its subnet, from an id list', () => {
    // `elb_virsubnet_ids` holds several subnets; `vip_subnet_cidr_id` names a
    // neutron subnet that is not one of this account's resources and so points
    // at nothing. The list is the placement.
    const topology = deriveInventoryTopology([
      resource('vpc-1', 'vpc', 'vpcs', {}, 'prod'),
      resource('sub-1', 'vpc', 'subnets', { vpcId: 'vpc-1' }, 'web'),
      resource('elb-1', 'elb', 'loadbalancers', {
        vpc_id: 'vpc-1',
        elb_virsubnet_ids: ['sub-1'],
        vip_subnet_cidr_id: 'neutron-subnet-not-a-resource',
      }, 'elb'),
    ])
    expect(parentOfNode(topology, 'elb-1')).toBe('sub-1')
  })

  it('leaves a reciprocal pair at the root rather than guessing', () => {
    // An EIP names a bandwidth and the bandwidth names the EIP. Neither is a
    // location, so neither goes inside the other — the relationship is drawn
    // as an arrow instead, which is what it is.
    const topology = deriveInventoryTopology([
      resource('eip-1', 'vpc', 'publicips', { bandwidth: { id: 'bw-1' } }, '1.2.3.4'),
      resource('bw-1', 'vpc', 'bandwidths', { publicipInfo: { publicipId: 'eip-1' } }, '5Mbit'),
    ])
    expect(topology.nodes.map(node => node.parent)).toEqual([undefined, undefined])
    expect(topology.roots).toHaveLength(2)
    expect(topology.edges).toHaveLength(2)
  })

  it('carries the attribute that established each relationship', () => {
    // The edge names where it came from, so a reader can check the claim
    // against the inventory rather than taking the picture on trust.
    const topology = deriveInventoryTopology([
      resource('vpc-1', 'vpc', 'vpcs', {}),
      resource('srv-1', 'ecs', 'cloudservers', { vnic: { vpcId: 'vpc-1' } }),
    ])
    expect(topology.edges[0]).toMatchObject({
      from: 'srv-1', to: 'vpc-1', attribute: 'vnic.vpcId',
    })
  })

  it('draws a container three levels deep', () => {
    // network -> subnet -> workload. The degree rule could not do this: it
    // stopped one level down, so the workload landed in the VPC.
    const topology = deriveInventoryTopology([
      resource('vpc-1', 'vpc', 'vpcs', {}),
      resource('sub-1', 'vpc', 'subnets', { vpcId: 'vpc-1' }),
      resource('srv-1', 'ecs', 'cloudservers', { subnetId: 'sub-1' }),
    ])
    const server = topology.nodes.find(node => node.id === 'srv-1')
    expect(server?.ancestors).toEqual(['sub-1', 'vpc-1'])
    expect(topology.roots.map(node => node.id)).toEqual(['vpc-1'])
  })

  it('collapses a resource the inventory reported twice', () => {
    // The inventory paginates per service, so a query overlapping two services
    // can return the same resource both times. Its id is the identity.
    const topology = deriveInventoryTopology([
      resource('vpc-1', 'vpc', 'vpcs', {}, 'prod'),
      resource('vpc-1', 'vpc', 'vpcs', {}, 'prod'),
    ])
    expect(topology.nodes).toHaveLength(1)
    expect(topology.duplicates).toEqual(['vpc-1'])
  })

  it('treats a self-reference as no relationship', () => {
    const topology = deriveInventoryTopology([
      resource('sg-1', 'vpc', 'securityGroups', { security_group_rules: [{ remote_group_id: 'sg-1' }] }),
    ])
    expect(topology.edges).toHaveLength(0)
  })

  it('breaks a cycle rather than looping', () => {
    // Three resources each naming the next. The derivation must terminate and
    // leave the picture readable, not hang.
    const topology = deriveInventoryTopology([
      resource('a', 'p', 'ts', { next: 'b' }),
      resource('b', 'p', 'ts', { next: 'c' }),
      resource('c', 'p', 'ts', { next: 'a' }),
    ])
    expect(topology.nodes).toHaveLength(3)
    for (const node of topology.nodes) {
      expect(node.ancestors.length).toBeLessThan(3)
    }
  })

  it('labels a resource without a name from its type and id', () => {
    const topology = deriveInventoryTopology([
      resource('abcdef123456', 'vpc', 'securityGroups'),
    ])
    expect(topology.nodes[0]?.label).toContain('vpc/securityGroups')
  })

  it('does not repeat the name as a fact', () => {
    // An EIP whose name IS its address showed the same string twice on one box.
    const topology = deriveInventoryTopology([
      resource('eip-1', 'vpc', 'publicips', { name: '1.2.3.4', publicIpAddress: '1.2.3.4' }, '1.2.3.4'),
    ])
    expect(topology.nodes[0]?.facts).toEqual([])
  })
})