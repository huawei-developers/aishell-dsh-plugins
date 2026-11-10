/**
 * Drawing a design with the same renderer as an account.
 *
 * The point of sharing is that the two pictures can be compared: same boxes,
 * same spacing, same colours. What the design adds is the one distinction an
 * account does not have — a resource the deployment reuses rather than creates
 * — and it has to survive into the SVG, because it is the first thing a
 * reviewer checks.
 */

import { describe, it, expect } from 'vitest'

import { buildDesignDiagram, designLabel, renderDesignDiagram } from '../src/design-render.ts'
import { parseResources } from '../src/hcl.ts'
import { deriveTopology, edgesOf } from '../src/topology.ts'
import type { ExistingResource } from '../src/existing.ts'

/** A small network, so every part of the conversion is exercised. */
const NETWORK = `
resource "huaweicloud_vpc" "prod" {
  name = "prod-vpc"
  cidr = "10.0.0.0/16"
}

resource "huaweicloud_vpc_subnet" "web" {
  name       = "web"
  cidr       = "10.0.1.0/24"
  vpc_id     = huaweicloud_vpc.prod.id
  gateway_ip = "10.0.1.1"
}

resource "huaweicloud_networking_secgroup" "api" {
  name = "api"
}
`

describe('designLabel', () => {
  it('heads a box with the cloud caption and its name', () => {
    const topology = deriveTopology(parseResources(NETWORK))
    const vpc = topology.nodes.find(node => node.kind === 'vpc')!
    expect(designLabel(vpc)).toContain('VPC')
    expect(designLabel(vpc)).toContain('prod-vpc')
  })

  it('leads a rule with what it admits, not its label', () => {
    // A rule's terraform label is the model's own (`ssh`); the effect is what a
    // reviewer checks.
    const rules = parseResources(`
resource "huaweicloud_networking_secgroup" "web" { name = "web" }

resource "huaweicloud_networking_secgroup_rule" "ssh" {
  direction         = "ingress"
  ethertype         = "IPv4"
  protocol          = "tcp"
  ports             = "22"
  remote_ip_prefix  = "0.0.0.0/0"
  security_group_id = huaweicloud_networking_secgroup.web.id
}
`)
    const topology = deriveTopology(rules)
    const rule = topology.nodes.find(node => node.kind === 'security-group-rule')!
    expect(designLabel(rule)).toContain('ingress')
    expect(designLabel(rule)).toContain('22')
    expect(designLabel(rule)).toContain('0.0.0.0/0')
  })
})

describe('buildDesignDiagram', () => {
  it('nests the subnet inside the VPC', () => {
    // The design path's nesting comes from terraform references, resolved by
    // `topology.ts`; this module must not lose it.
    const topology = deriveTopology(parseResources(NETWORK))
    const diagram = buildDesignDiagram(topology, [])
    const vpc = diagram.boxes.find(box => box.id === 'huaweicloud_vpc.prod')!
    const subnet = diagram.boxes.find(box => box.id === 'huaweicloud_vpc_subnet.web')!
    expect(subnet.x).toBeGreaterThanOrEqual(vpc.x)
    expect(subnet.y).toBeGreaterThanOrEqual(vpc.y)
    expect(subnet.x + subnet.width).toBeLessThanOrEqual(vpc.x + vpc.width)
  })

  it('draws a reused resource dashed', () => {
    // The distinction a reviewer checks first. It travels on the box, so the
    // renderer can draw it without knowing what an "existing" resource is.
    const existing: ExistingResource = {
      id: 'vpc-0a1b',
      type: 'huaweicloud_vpc',
      name: 'prod-vpc',
      address: 'huaweicloud_vpc.prod',
    }
    const topology = deriveTopology(parseResources(NETWORK), [existing])
    const diagram = buildDesignDiagram(topology, [])
    const { svg } = renderDesignDiagram(topology, [])
    const placed = diagram.boxes.find(box => box.id === 'vpc-0a1b')
    expect(placed?.existing).toBe(true)
    expect(svg).toContain('stroke-dasharray')
  })

  it('labels a connection between networks rather than drawing a plain arrow', () => {
    const blocks = parseResources(`
resource "huaweicloud_vpc" "a" {
  name = "a"
  cidr = "10.0.0.0/16"
}
resource "huaweicloud_vpc" "b" {
  name = "b"
  cidr = "10.1.0.0/16"
}
resource "huaweicloud_vpc_peering_connection" "ab" {
  name   = "ab"
  vpc_id = huaweicloud_vpc.a.id
  peer_vpc_id = huaweicloud_vpc.b.id
}
`)
    const topology = deriveTopology(blocks)
    const edges = edgesOf(blocks, topology)
    const diagram = buildDesignDiagram(topology, edges)
    // A connection is the one relationship the nesting cannot express, so it is
    // the one edge in the picture — and it carries the cloud's own term.
    expect(diagram.edges.length).toBeGreaterThan(0)
    expect(diagram.edges.some(edge => edge.label !== '')).toBe(true)
  })

  it('renders an empty design without failing', () => {
    const { svg } = renderDesignDiagram(
      { roots: [], nodes: [], findings: [], kinds: [], connections: [], omitted: [] },
      [],
    )
    expect(svg).toContain('<svg')
    expect(svg).toContain('</svg>')
  })

  it('declares its own size, like the account picture', () => {
    const topology = deriveTopology(parseResources(NETWORK))
    const { diagram, svg } = renderDesignDiagram(topology, [])
    expect(svg).toContain(`width="${diagram.width}"`)
    expect(svg).toContain(`height="${diagram.height}"`)
  })
})