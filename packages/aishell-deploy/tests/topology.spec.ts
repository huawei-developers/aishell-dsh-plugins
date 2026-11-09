/**
 * Reading the network design out of HCL.
 *
 * These tests run against real `.tf` text — the shapes the provider's own
 * examples use — because the thing under test is how a configuration maps onto
 * a picture. A fixture that is easier to parse than real configuration would
 * pass while the real one dropped boxes.
 *
 * The parser itself is not tested here: it is a compiled Go grammar, and
 * `hcl.ts` only wraps it. What IS tested is every decision this module makes
 * around it — which blocks become nodes, which references decide containment,
 * and what happens when the text is broken.
 */

import { describe, it, expect } from 'vitest'

import { firstReference, literalOf, parseResources, referencesOf } from '../src/hcl.ts'
import { deriveTopology, edgesOf } from '../src/topology.ts'

/** A two-tier network, as a user would write it. */
const VPC_AND_SUBNETS = `
resource "huaweicloud_vpc" "prod" {
  name = "prod-vpc"
  cidr = "10.0.0.0/16"
}

resource "huaweicloud_vpc_subnet" "web" {
  name              = "web"
  cidr              = "10.0.1.0/24"
  vpc_id            = huaweicloud_vpc.prod.id
  gateway_ip        = "10.0.1.1"
  availability_zone = "cn-north-4a"
}
`

describe('parseResources', () => {
  it('returns one block per resource, with its type and name', () => {
    const blocks = parseResources(VPC_AND_SUBNETS)
    expect(blocks.map(block => `${block.type}.${block.name}`)).toEqual([
      'huaweicloud_vpc.prod',
      'huaweicloud_vpc_subnet.web',
    ])
  })

  it('keeps expressions exactly as written', () => {
    const subnet = parseResources(VPC_AND_SUBNETS).find(block => block.name === 'web')
    // The value terraform will compute is unknowable here; what matters is the
    // reference it carries. Rewriting it to a "clean" value would lose the thread
    // the diagram is drawn from.
    expect(subnet?.body.vpc_id).toBe('${huaweicloud_vpc.prod.id}')
  })

  it('reads other block types without turning them into resources', () => {
    const blocks = parseResources(`
variable "region" {
  default = "cn-north-4"
}
resource "huaweicloud_vpc" "v" {
  name = "v"
  cidr = "10.0.0.0/16"
}
`)
    expect(blocks).toHaveLength(1)
    expect(blocks[0]?.type).toBe('huaweicloud_vpc')
  })

  it('reports a syntax error as a problem with the configuration', () => {
    // The parser answers a broken file with a null tree and an EMPTY error
    // object, so it cannot say where. The message has to say what the reader
    // can act on rather than pass on the empty object.
    expect(() => parseResources('resource "huaweicloud_vpc" "v" {\n'))
      .toThrow(/not valid HCL/)
  })

  it('returns nothing for a file that declares no resources', () => {
    expect(parseResources('# just a comment\n')).toEqual([])
  })

  it('reads a block whose body is empty', () => {
    // Real configurations use this for variables and for resources that take
    // every argument from a default.
    const blocks = parseResources('resource "huaweicloud_vpc" "empty" {\n}\n')
    expect(blocks).toHaveLength(1)
    expect(blocks[0]?.body).toEqual({})
  })
})

describe('literalOf', () => {
  it('returns a plain string', () => {
    const blocks = parseResources(VPC_AND_SUBNETS)
    expect(literalOf(blocks[0]?.body ?? {}, 'cidr')).toBe('10.0.0.0/16')
  })

  it('returns undefined for an expression rather than the expression text', () => {
    // `var.x` resolves to something only terraform knows. Reporting the text
    // would put `var.cidr` on the diagram, where it reads as the value.
    const body = { cidr: '${var.vpc_cidr}' }
    expect(literalOf(body, 'cidr')).toBeUndefined()
  })

  it('returns undefined for a missing and for an empty attribute', () => {
    expect(literalOf({}, 'cidr')).toBeUndefined()
    expect(literalOf({ cidr: '' }, 'cidr')).toBeUndefined()
  })
})

describe('referencesOf', () => {
  it('finds the resources an expression reaches through', () => {
    const body = { vpc_id: '${huaweicloud_vpc.prod.id}' }
    expect(referencesOf(body)).toEqual(['huaweicloud_vpc.prod'])
  })

  it('finds references inside nested collections', () => {
    const body = {
      security_groups: ['${huaweicloud_networking_secgroup.web.id}'],
      network: [{ uuid: '${huaweicloud_vpc_subnet.web.id}' }],
    }
    expect(referencesOf(body)).toEqual([
      'huaweicloud_networking_secgroup.web',
      'huaweicloud_vpc_subnet.web',
    ])
  })

  it('deduplicates repeated references', () => {
    const body = {
      a: '${huaweicloud_vpc.prod.id}',
      b: '${huaweicloud_vpc.prod.name}',
    }
    expect(referencesOf(body)).toEqual(['huaweicloud_vpc.prod'])
  })

  it('ignores variables, locals and local function calls', () => {
    const body = { cidr: '${var.cidr}', name: '${local.prefix}-web' }
    expect(referencesOf(body)).toEqual([])
  })

  it('returns the first reference for a single-value lookup', () => {
    expect(firstReference('${huaweicloud_vpc.prod.id}')).toBe('huaweicloud_vpc.prod')
    expect(firstReference('plain text')).toBeUndefined()
  })
})

describe('deriveTopology', () => {
  it('nests a subnet inside the VPC its vpc_id names', () => {
    const topology = deriveTopology(parseResources(VPC_AND_SUBNETS))
    const vpc = topology.roots[0]
    expect(vpc?.address).toBe('huaweicloud_vpc.prod')
    expect(vpc?.children.map(child => child.address)).toEqual(['huaweicloud_vpc_subnet.web'])
  })

  it('places a child correctly even when it is declared before its parent', () => {
    // Files are read in name order, so this is the normal case: a subnet in
    // `main.tf` whose VPC is in `network.tf` is parsed first.
    const blocks = parseResources(`
resource "huaweicloud_vpc_subnet" "web" {
  name       = "web"
  cidr       = "10.0.1.0/24"
  vpc_id     = huaweicloud_vpc.prod.id
  gateway_ip = "10.0.1.1"
}
resource "huaweicloud_vpc" "prod" {
  name = "prod-vpc"
  cidr = "10.0.0.0/16"
}
`)
    const topology = deriveTopology(blocks)
    expect(topology.roots.map(node => node.address)).toEqual(['huaweicloud_vpc.prod'])
    expect(topology.roots[0]?.children.map(child => child.address))
      .toEqual(['huaweicloud_vpc_subnet.web'])
  })

  it('leaves a node unparented when its containment reference is unknown', () => {
    // The failure direction that matters: a node at the root is visibly wrong
    // and fixable, while a node nested in the wrong box looks correct.
    const blocks = parseResources(`
resource "huaweicloud_vpc_subnet" "web" {
  name       = "web"
  cidr       = "10.0.1.0/24"
  vpc_id     = huaweicloud_vpc.missing.id
  gateway_ip = "10.0.1.1"
}
`)
    const topology = deriveTopology(blocks)
    expect(topology.nodes[0]?.parent).toBeUndefined()
  })

  it('does not parent a node onto a reference of the wrong kind', () => {
    // `vpc_id` naming something that is not a VPC — the containment rule
    // requires both the attribute AND the target kind to agree.
    const blocks = parseResources(`
resource "huaweicloud_networking_secgroup" "sg" {
  name = "sg"
}
resource "huaweicloud_vpc_subnet" "web" {
  name       = "web"
  cidr       = "10.0.1.0/24"
  vpc_id     = huaweicloud_networking_secgroup.sg.id
  gateway_ip = "10.0.1.1"
}
`)
    const subnet = deriveTopology(blocks).nodes.find(node => node.name === 'web')
    expect(subnet?.parent).toBeUndefined()
  })

  it('nests a security-group rule inside its group', () => {
    const blocks = parseResources(`
resource "huaweicloud_networking_secgroup" "web" {
  name = "web-sg"
}
resource "huaweicloud_networking_secgroup_rule" "https" {
  direction         = "ingress"
  ethertype         = "IPv4"
  protocol          = "tcp"
  ports             = "443"
  remote_ip_prefix  = "0.0.0.0/0"
  security_group_id = huaweicloud_networking_secgroup.web.id
}
`)
    const topology = deriveTopology(blocks)
    const group = topology.nodes.find(node => node.kind === 'security-group')
    expect(group?.children.map(child => child.kind)).toEqual(['security-group-rule'])
  })

  it('sorts siblings by kind rather than by parse order', () => {
    const blocks = parseResources(`
resource "huaweicloud_networking_secgroup" "sg" {
  name = "sg"
}
resource "huaweicloud_vpc" "prod" {
  name = "prod-vpc"
  cidr = "10.0.0.0/16"
}
`)
    // The VPC is declared second but must be drawn first: siblings read
    // top-down as the network is built.
    expect(deriveTopology(blocks).roots.map(node => node.kind)).toEqual(['vpc', 'security-group'])
  })

  it('shows a literal fact and omits an expression it cannot resolve', () => {
    const blocks = parseResources(`
resource "huaweicloud_vpc_subnet" "web" {
  name              = "web"
  cidr              = "10.0.1.0/24"
  gateway_ip        = "10.0.1.1"
  availability_zone = var.az
}
`)
    const node = deriveTopology(blocks).nodes[0]
    // `availability_zone = var.az` is omitted rather than shown as `var.az`,
    // which would read as the value the subnet will have.
    expect(node?.facts).toEqual([
      { key: 'name', value: 'web' },
      { key: 'cidr', value: '10.0.1.0/24' },
      { key: 'gateway_ip', value: '10.0.1.1' },
    ])
  })

  it('shows a reference as a fact, because it names a relationship', () => {
    // A rule that admits another security group rather than a CIDR: the fact is
    // the GROUP, which is what a reader has to trace.
    const blocks = parseResources(`
resource "huaweicloud_networking_secgroup" "web" {
  name = "web-sg"
}
resource "huaweicloud_networking_secgroup_rule" "from_web" {
  direction         = "ingress"
  ports             = "3306"
  remote_group_id   = huaweicloud_networking_secgroup.web.id
}
`)
    const rule = deriveTopology(blocks).nodes.find(node => node.kind === 'security-group-rule')
    expect(rule?.facts).toContainEqual({
      key: 'remote_group_id',
      value: 'huaweicloud_networking_secgroup.web',
    })
  })
})

describe('edgesOf', () => {
  it('draws a reference the nesting does not already show', () => {
    const blocks = parseResources(`
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
resource "huaweicloud_networking_secgroup" "sg" {
  name = "sg"
}
resource "huaweicloud_vpc_eip" "nat" {
  publicip {
    type = "5_bgp"
  }
  bandwidth {
    name       = "b"
    size       = 5
    share_type = "PER"
  }
  port_id = huaweicloud_vpc_subnet.web.id
}
`)
    const topology = deriveTopology(blocks)
    expect(edgesOf(blocks, topology)).toContainEqual({
      from: 'huaweicloud_vpc_eip.nat',
      to: 'huaweicloud_vpc_subnet.web',
    })
  })

  it('does not draw an edge for containment, which the nesting already shows', () => {
    // An arrow from a subnet to the VPC that already contains it reads as a
    // relationship between peers — the one thing the picture must not say.
    const blocks = parseResources(VPC_AND_SUBNETS)
    const topology = deriveTopology(blocks)
    expect(edgesOf(blocks, topology)).toEqual([])
  })

  it('does not draw an edge to a resource the topology does not hold', () => {
    const blocks = parseResources(`
resource "huaweicloud_vpc_subnet" "web" {
  name       = "web"
  cidr       = "10.0.1.0/24"
  vpc_id     = huaweicloud_vpc.outside.id
  gateway_ip = "10.0.1.1"
}
`)
    const topology = deriveTopology(blocks)
    expect(edgesOf(blocks, topology)).toEqual([])
  })
})
describe('what the picture leaves out', () => {
  /** A network with one supporting resource of a type the diagram is not about. */
  const WITH_ALARM = `${VPC_AND_SUBNETS}
resource "huaweicloud_ces_alarmrule" "cpu" {
  alarm_name = "cpu-high"
}
`

  it('counts the resources it did not draw, by type', () => {
    // 1874 resource types exist and 438 appear in the provider's examples; the
    // picture shows the network and what it carries. Everything else is
    // reported so the reader knows the diagram is a view, not an inventory.
    const topology = deriveTopology(parseResources(WITH_ALARM))
    expect(topology.nodes).toHaveLength(2)
    expect(topology.omitted).toEqual([{ type: 'huaweicloud_ces_alarmrule', count: 1 }])
  })

  it('does not draw an unclassified resource at the root', () => {
    // An unclassified box drawn at the root reads as "this belongs nowhere in
    // particular" — a claim about placement that nothing checked. The type is
    // reported under `omitted` instead.
    const topology = deriveTopology(parseResources(WITH_ALARM))
    expect(topology.nodes.map(node => node.type)).not.toContain('huaweicloud_ces_alarmrule')
  })

  it('orders the omissions by count, so the biggest surprise comes first', () => {
    const topology = deriveTopology(parseResources(`${VPC_AND_SUBNETS}
resource "huaweicloud_ces_alarmrule" "a" {}
resource "huaweicloud_lts_group" "b" {}
resource "huaweicloud_lts_group" "c" {}
`))
    expect(topology.omitted).toEqual([
      { type: 'huaweicloud_lts_group', count: 2 },
      { type: 'huaweicloud_ces_alarmrule', count: 1 },
    ])
  })

  it('reports nothing when the configuration is entirely network', () => {
    expect(deriveTopology(parseResources(VPC_AND_SUBNETS)).omitted).toEqual([])
  })

  it('leaves existing resources of unclassified types out on the same rule', () => {
    // A caller that sent the account's whole inventory gets the network it
    // designed, not the key pairs that happened to be in it.
    const topology = deriveTopology([], [
      { id: 'alarm-1', type: 'ala', name: 'alarm' } as never,
      { id: 'vpc-1', type: 'vpc', name: 'prod' } as never,
    ])
    expect(topology.nodes.map(node => node.address)).toEqual(['vpc-1'])
    expect(topology.omitted).toEqual([{ type: 'ala', count: 1 }])
  })
})

describe('connections between networks', () => {
  /** Two VPCs, joined by whatever `joining` declares. */
  const twoVpcs = (joining: string): string => `
resource "huaweicloud_vpc" "a" {
  cidr = "10.0.0.0/16"
}

resource "huaweicloud_vpc" "b" {
  cidr = "10.1.0.0/16"
}
${joining}
`

  it('reads a peering as an edge between the two VPCs, not as a box', () => {
    // A peering connection has no location of its own. Drawn as a node it would
    // put a box in the network that contains nothing, and leave the two VPCs it
    // joins looking unrelated — which is the one fact the picture exists to
    // show.
    const blocks = parseResources(twoVpcs(`
resource "huaweicloud_vpc_peering_connection" "peer" {
  vpc_id      = huaweicloud_vpc.a.id
  peer_vpc_id = huaweicloud_vpc.b.id
}
`))
    const topology = deriveTopology(blocks)
    expect(topology.nodes.map(node => node.address)).toEqual([
      'huaweicloud_vpc.a',
      'huaweicloud_vpc.b',
    ])
    expect(topology.connections).toEqual([{
      address: 'huaweicloud_vpc_peering_connection.peer',
      type: 'huaweicloud_vpc_peering_connection',
      kind: 'peering',
      from: 'huaweicloud_vpc.a',
      to: 'huaweicloud_vpc.b',
    }])
    expect(edgesOf(blocks, topology)).toEqual([{
      from: 'huaweicloud_vpc.a',
      to: 'huaweicloud_vpc.b',
      connection: 'peering',
    }])
  })

  it('follows an endpoint through its service to the far VPC', () => {
    // `service_id` names an endpoint SERVICE, which is an entry point rather
    // than a box. What the endpoint buys the VPC is reachability to the network
    // that service publishes from, so the hop is followed.
    const blocks = parseResources(`
resource "huaweicloud_vpc" "client" {
  cidr = "10.10.0.0/16"
}

resource "huaweicloud_vpc" "server" {
  cidr = "10.20.0.0/16"
}

resource "huaweicloud_vpcep_service" "svc" {
  name   = "svc"
  vpc_id = huaweicloud_vpc.server.id
}

resource "huaweicloud_vpcep_endpoint" "ec" {
  service_id = huaweicloud_vpcep_service.svc.id
  vpc_id     = huaweicloud_vpc.client.id
}
`)
    const topology = deriveTopology(blocks)
    expect(edgesOf(blocks, topology)).toEqual([{
      from: 'huaweicloud_vpc.client',
      to: 'huaweicloud_vpc.server',
      connection: 'endpoint',
    }])
  })

  it('leaves the far side unset when the service belongs elsewhere', () => {
    // The normal VPCEP case: a published service in another account. The far
    // network is not in this configuration, and inventing a box for it would
    // place a network this design does not own.
    const blocks = parseResources(twoVpcs(`
resource "huaweicloud_vpcep_endpoint" "ec" {
  service_id = "some-published-service-id"
  vpc_id     = huaweicloud_vpc.a.id
}
`))
    const topology = deriveTopology(blocks)
    expect(topology.connections[0]?.from).toBe('huaweicloud_vpc.a')
    expect(topology.connections[0]?.to).toBeUndefined()
    // Nothing drawable, so nothing drawn — and no arrow to a guess.
    expect(edgesOf(blocks, topology)).toEqual([])
  })

  it('does not report a connection as something the picture left out', () => {
    // It IS in the picture, as an edge. Counting it under `omitted` would tell
    // the reader the opposite of the truth.
    const blocks = parseResources(twoVpcs(`
resource "huaweicloud_vpc_peering_connection" "peer" {
  vpc_id      = huaweicloud_vpc.a.id
  peer_vpc_id = huaweicloud_vpc.b.id
}
`))
    expect(deriveTopology(blocks).omitted).toEqual([])
  })

  it('keeps a plain reference arrow apart from a connection arrow', () => {
    // "This one names that one" and "these two are reachable from each other"
    // are different claims; only the second carries a label.
    const blocks = parseResources(`${twoVpcs(`
resource "huaweicloud_vpc_peering_connection" "peer" {
  vpc_id      = huaweicloud_vpc.a.id
  peer_vpc_id = huaweicloud_vpc.b.id
}
`)}
resource "huaweicloud_networking_secgroup" "web" {
  name = "web"
}

resource "huaweicloud_networking_secgroup_rule" "ssh" {
  security_group_id = huaweicloud_networking_secgroup.web.id
  direction         = "ingress"
  ports             = "22"
}
`)
    const topology = deriveTopology(blocks)
    const edges = edgesOf(blocks, topology)
    expect(edges.find(edge => edge.connection === 'peering')).toBeDefined()
    // The rule is nested inside its group, so that relationship is the nesting
    // rather than an arrow; nothing here carries a label but the peering.
    expect(edges.filter(edge => edge.connection !== undefined)).toHaveLength(1)
  })

  it('reads a route as a connection out of its VPC', () => {
    const blocks = parseResources(twoVpcs(`
resource "huaweicloud_vpc_route" "to_b" {
  vpc_id     = huaweicloud_vpc.a.id
  next_hop   = huaweicloud_vpc.b.id
  type       = "peering"
  destination = "10.1.0.0/16"
}
`))
    const topology = deriveTopology(blocks)
    expect(edgesOf(blocks, topology)).toEqual([{
      from: 'huaweicloud_vpc.a',
      to: 'huaweicloud_vpc.b',
      connection: 'route',
    }])
  })
})

describe('identifiers in other scripts', () => {
  // HCL admits any letter in a label, and this provider's users write Chinese
  // ones constantly. An ASCII-only identifier pattern matched none of those
  // references, so a subnet whose `vpc_id` named a Chinese-labelled VPC was
  // drawn at the root, outside the VPC it belongs to — verified before the fix.
  const CJK = `
resource "huaweicloud_vpc" "生产网络" {
  name = "生产-VPC"
  cidr = "10.0.0.0/16"
}

resource "huaweicloud_vpc_subnet" "web" {
  name   = "Web层"
  vpc_id = huaweicloud_vpc.生产网络.id
  cidr   = "10.0.1.0/24"
}
`

  it('resolves a reference that names a Chinese-labelled resource', () => {
    const blocks = parseResources(CJK)
    const subnet = blocks.find(block => block.name === 'web')
    expect(referencesOf(subnet!.body)).toEqual(['huaweicloud_vpc.生产网络'])
  })

  it('nests the subnet inside that VPC', () => {
    const topology = deriveTopology(parseResources(CJK))
    const subnet = topology.nodes.find(node => node.name === 'web')
    expect(subnet?.parent).toBe('huaweicloud_vpc.生产网络')
  })

  it('draws the CJK labels', () => {
    const topology = deriveTopology(parseResources(CJK))
    expect(topology.nodes.find(node => node.name === '生产网络')?.facts)
      .toContainEqual({ key: 'name', value: '生产-VPC' })
  })

  it('still reads ASCII identifiers, and mixes the two', () => {
    // The Unicode class has to include the ASCII case, not replace it.
    const topology = deriveTopology(parseResources(`
resource "huaweicloud_vpc" "prod" {
  cidr = "10.0.0.0/16"
}

resource "huaweicloud_vpc_subnet" "网络" {
  vpc_id = huaweicloud_vpc.prod.id
  cidr   = "10.0.1.0/24"
}
`))
    expect(topology.nodes.find(node => node.name === '网络')?.parent).toBe('huaweicloud_vpc.prod')
  })
})
