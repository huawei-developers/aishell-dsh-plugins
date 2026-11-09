/**
 * Subnets, which RMS does not report.
 *
 * What is worth testing here is the shape translation, because that is where
 * the two vocabularies meet: the VPC API answers with snake_case fields, and
 * the inventory's everything else arrives with a `properties` object whose
 * attribute names are what decides placement. A subnet whose `vpc_id` did not
 * reach `properties` would be drawn at the root and its VPC would look empty.
 *
 * The fixtures are the real response shape, taken from a live account.
 */

import { describe, it, expect } from 'vitest'

import { asInventorySubnet } from '../src/inventory-subnets.ts'
import { deriveInventoryTopology, locationRank } from '../src/existing-topology.ts'

/** One record as `GET /v1/{project}/subnets` returns it. */
const LIVE_SUBNET = {
  id: '0e2714fd-3ec5-45ac-b89b-ba2235999af1',
  name: 'subnet-aishell-e2b',
  cidr: '172.16.240.0/20',
  status: 'ACTIVE',
  vpc_id: '73e76381-c33b-46bc-975d-755e4f4f1190',
  gateway_ip: '172.16.240.1',
  neutron_network_id: '0e2714fd-3ec5-45ac-b89b-ba2235999af1',
  neutron_subnet_id: 'd88975a2-3a70-44c1-b68a-f40adb5c2d7f',
  dnsList: ['100.125.1.250'],
}

describe('asInventorySubnet', () => {
  it('carries the VPC id where placement looks for it', () => {
    const subnet = asInventorySubnet(LIVE_SUBNET, 'cn-north-4')
    expect(subnet?.properties['vpc_id']).toBe('73e76381-c33b-46bc-975d-755e4f4f1190')
    // The rule that reads it: a `vpc_id` attribute names a VPC.
    expect(locationRank('vpc_id')).toBe(1)
  })

  it('keeps the facts a reader compares subnets by', () => {
    const subnet = asInventorySubnet(LIVE_SUBNET, 'cn-north-4')
    expect(subnet?.properties).toMatchObject({
      cidr: '172.16.240.0/20',
      gateway_ip: '172.16.240.1',
      status: 'ACTIVE',
    })
  })

  it('lands in the same vocabulary the rest of the inventory uses', () => {
    const subnet = asInventorySubnet(LIVE_SUBNET, 'cn-north-4')
    expect(subnet).toMatchObject({ provider: 'vpc', type: 'subnets', region: 'cn-north-4' })
  })

  it('ignores a record with no id, which is not a node', () => {
    expect(asInventorySubnet({ name: 'orphan' }, 'cn-north-4')).toBeUndefined()
    expect(asInventorySubnet({ id: '' }, 'cn-north-4')).toBeUndefined()
  })

  it('falls back to a short id when the subnet has no name', () => {
    const subnet = asInventorySubnet({ id: 'abcdef123456' }, 'cn-north-4')
    expect(subnet?.name).toBe('abcdef12')
  })

  it('does not invent a vpc_id the response did not carry', () => {
    // A missing reference is a fact, not something to fill in — the subnet then
    // sits at the root, which a reader can see and correct.
    const subnet = asInventorySubnet({ id: 'sub-1', name: 'x' }, 'cn-north-4')
    expect(subnet?.properties).not.toHaveProperty('vpc_id')
  })
})

describe('a subnet among the rest of the inventory', () => {
  it('places the subnet in its VPC, and a server in the subnet', () => {
    // The chain the whole module exists for. Without subnets in the data, the
    // server has nothing to be placed in and lands in the VPC.
    const subnet = asInventorySubnet(LIVE_SUBNET, 'cn-north-4')!
    const topology = deriveInventoryTopology([
      {
        id: '73e76381-c33b-46bc-975d-755e4f4f1190',
        provider: 'vpc', type: 'vpcs', name: 'vpc-aishell',
        properties: { cidr: '172.16.0.0/12' },
      },
      subnet,
      {
        id: 'srv-1',
        provider: 'apig', type: 'instances', name: 'apig-aishell-e2b',
        properties: { vpc_id: '73e76381-c33b-46bc-975d-755e4f4f1190', subnet_id: LIVE_SUBNET.id },
      },
    ])
    const byId = new Map(topology.nodes.map(node => [node.id, node]))
    expect(byId.get(subnet.id)?.parent).toBe('73e76381-c33b-46bc-975d-755e4f4f1190')
    expect(byId.get('srv-1')?.parent).toBe(subnet.id)
    expect(byId.get('srv-1')?.ancestors).toEqual([
      subnet.id, '73e76381-c33b-46bc-975d-755e4f4f1190',
    ])
  })
})