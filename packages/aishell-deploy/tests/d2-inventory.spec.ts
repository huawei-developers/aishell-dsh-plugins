/**
 * Drawing an account that already exists.
 *
 * This path has no closed vocabulary, so what is worth pinning is not "does a
 * VPC look like a VPC" but the two properties a caller depends on when the
 * inventory can contain any service at all:
 *
 *   - **It always produces source.** A service this deployment has never seen
 *     gets a class by hash, not by lookup, so nothing has to be added for it.
 *   - **It is readable.** D2 lays unconnected roots out in one row, and a real
 *     account comes out as an unreadable strip; the grid is what fixes that,
 *     and the ratio is measured rather than asserted.
 *
 * The fixtures are the shape of a live 30-resource account.
 */

import { describe, it, expect } from 'vitest'

import { deriveInventoryTopology } from '../src/existing-topology.ts'
import { drawnEdges, inventoryClass, inventoryToD2, renderInventoryTopology } from '../src/d2-inventory.ts'

/** A resource, in the shape the inventory returns. */
function resource(
  id: string,
  provider: string,
  type: string,
  properties: Record<string, unknown> = {},
  name?: string,
) {
  return { id, provider, type, properties, ...(name === undefined ? {} : { name }) }
}

/** A VPC with two subnets and a workload in one of them. */
const ACCOUNT = [
  resource('vpc-1', 'vpc', 'vpcs', { cidr: '10.0.0.0/16' }, 'prod'),
  resource('sub-1', 'vpc', 'subnets', { vpcId: 'vpc-1', cidr: '10.0.1.0/24' }, 'web'),
  resource('sub-2', 'vpc', 'subnets', { vpcId: 'vpc-1', cidr: '10.0.2.0/24' }, 'db'),
  resource('srv-1', 'ecs', 'cloudservers', { subnetId: 'sub-1' }, 'app'),
]

describe('inventoryClass', () => {
  it('gives every provider a class without knowing the provider', () => {
    // The point of the hash: a service this build has never seen still draws.
    for (const provider of ['vpc', 'ecs', 'rds', 'a-service-from-the-future']) {
      expect(inventoryClass(provider, 'someType'), provider).toMatch(/^fill-/)
    }
  })

  it('separates the types inside one provider', () => {
    // Colouring by provider alone made a picture of one VPC and nine security
    // groups read as ten of the same thing.
    expect(inventoryClass('vpc', 'vpcs')).not.toBe(inventoryClass('vpc', 'securityGroups'))
  })

  it('is stable across runs and orderings', () => {
    // Two diagrams of the same account must be comparable, which requires the
    // same input to give the same colour every time.
    expect(inventoryClass('vpc', 'subnets')).toBe(inventoryClass('vpc', 'subnets'))
  })
})

describe('inventoryToD2', () => {
  it('writes the theme both ways round', () => {
    const source = inventoryToD2(deriveInventoryTopology(ACCOUNT))
    expect(source).toContain('theme-id: 5')
    expect(source).toContain('dark-theme-id: 201')
  })

  it('nests a child inside its container rather than beside it', () => {
    const source = inventoryToD2(deriveInventoryTopology(ACCOUNT))
    // The subnet's line is indented inside the VPC's block.
    expect(source).toMatch(/^ {2}r_sub_1/m)
  })

  it('does not also draw an arrow for a containment', () => {
    // The nesting already says where the resource lives; an arrow would state
    // it a second time.
    const source = inventoryToD2(deriveInventoryTopology(ACCOUNT))
    expect(source).not.toContain('r_srv_1 -> r_sub_1')
  })

  it('draws an arrow for a relationship that is not containment', () => {
    const topology = deriveInventoryTopology([
      ...ACCOUNT,
      resource('sg-1', 'vpc', 'securityGroups', {}, 'sg-app'),
      // The server names the group, which is an association and not a location.
      resource('srv-2', 'ecs', 'cloudservers', { security_group_id: 'sg-1' }, 'app-2'),
    ])
    const source = inventoryToD2(topology)
    expect(source).toContain('r_srv_2 -> r_sg_1: "security_group_id"')
  })

  it('omits the grid when there are few enough roots to fit one row', () => {
    const source = inventoryToD2(deriveInventoryTopology([
      resource('vpc-1', 'vpc', 'vpcs', {}, 'prod'),
    ]))
    expect(source).not.toContain('grid-columns')
  })
})

describe('renderInventoryTopology', () => {
  it('renders a real-sized account into a readable shape', async () => {
    // The measurement that motivates the grid. A live 30-resource account has
    // 21 roots; without the grid D2 puts them in one row and the SVG is 9.6:1.
    const roots = Array.from({ length: 21 }, (_, index) => (
      resource(`r-${index}`, 'vpc', 'securityGroups', {}, `sg-${index}`)
    ))
    const { svg } = await renderInventoryTopology(deriveInventoryTopology(roots))
    const box = /viewBox="(-?\d+) (-?\d+) ([\d.]+) ([\d.]+)"/.exec(svg)
    expect(box).not.toBeNull()
    const ratio = Number(box![3]) / Number(box![4])
    // Anything past ~6:1 cannot be read inline at a normal width.
    expect(ratio).toBeLessThan(6)
  })

  it('renders an empty account without failing', async () => {
    const { svg, source } = await renderInventoryTopology(deriveInventoryTopology([]))
    expect(source).toContain('theme-id: 5')
    expect(svg).toContain('<svg')
  })
})
describe('drawnEdges — which associations become arrows', () => {
  /** A VPC holding a subnet holding a server, plus a peer at the root. */
  const NESTED = [
    resource('vpc-1', 'vpc', 'vpcs', {}, 'prod'),
    resource('sub-1', 'vpc', 'subnets', { vpc_id: 'vpc-1' }, 'web'),
    resource('srv-1', 'ecs', 'cloudservers', { subnet_id: 'sub-1' }, 'app'),
    resource('sg-1', 'vpc', 'securityGroups', {}, 'sg-app'),
  ]

  it('draws one arrow per pair, not two', () => {
    // The inventory reports both ends: an EIP names its bandwidth and the
    // bandwidth names the EIP. Both are true; one line says it. On a live
    // 49-resource account this was 8 pairs of doubled lines out of 40.
    const topology = deriveInventoryTopology([
      ...NESTED,
      resource('eip-1', 'vpc', 'publicips', { bandwidth: { id: 'bw-1' } }, '1.2.3.4'),
      resource('bw-1', 'vpc', 'bandwidths', { publicipInfo: { publicipId: 'eip-1' } }, '5Mbit'),
    ])
    const drawn = drawnEdges(topology)
    const betweenThem = drawn.filter(
      edge => (edge.from === 'eip-1' && edge.to === 'bw-1') || (edge.from === 'bw-1' && edge.to === 'eip-1'),
    )
    expect(betweenThem).toHaveLength(1)
  })

  it('does not draw an arrow for a containment', () => {
    const drawn = drawnEdges(deriveInventoryTopology(NESTED))
    expect(drawn.some(edge => edge.from === 'sub-1' && edge.to === 'vpc-1')).toBe(false)
  })

  it('does not draw an arrow to an ancestor, which nesting already shows', () => {
    // A server inside a subnet that also names the VPC. The VPC is visible from
    // where the server is drawn; a line leaving the container to reach it adds
    // no fact. Five such arrows on the live account, all `vpc_id`.
    const topology = deriveInventoryTopology([
      resource('vpc-1', 'vpc', 'vpcs', {}, 'prod'),
      resource('sub-1', 'vpc', 'subnets', { vpc_id: 'vpc-1' }, 'web'),
      resource('srv-1', 'ecs', 'cloudservers', { subnet_id: 'sub-1', vpc_id: 'vpc-1' }, 'app'),
    ])
    const drawn = drawnEdges(topology)
    expect(drawn.some(edge => edge.from === 'srv-1' && edge.to === 'vpc-1')).toBe(false)
  })

  it('keeps a genuine cross-container reference', () => {
    // A server inside the VPC naming a security group that lives outside it.
    // That is a relationship a reader has to follow, so it is drawn.
    const topology = deriveInventoryTopology([
      ...NESTED,
      resource('srv-2', 'ecs', 'cloudservers', { subnet_id: 'sub-1', security_group_id: 'sg-1' }, 'app-2'),
    ])
    const drawn = drawnEdges(topology)
    expect(drawn.some(edge => edge.from === 'srv-2' && edge.to === 'sg-1')).toBe(true)
  })
})
