/**
 * Designing around resources that already exist.
 *
 * The design stage answers "what should this network be". In an account with a
 * VPC in it, that question is partly "what can be reused", and a diagram drawn
 * only from the `.tf` answers a different one: it shows what will be created
 * and says nothing about what is already there.
 *
 * These tests pin the three things that makes work:
 *
 *   - an existing resource is a node, marked as existing, so a reader can tell
 *     the two apart;
 *   - a `.tf` reference to an undeclared resource resolves to the existing one
 *     the caller designated, so a new subnet lands inside the VPC it reuses;
 *   - a new subnet is compared against an existing one, which is the collision
 *     no `.tf`-only check can see.
 */

import { describe, it, expect } from 'vitest'

import { parseResources } from '../src/hcl.ts'
import { deriveTopology } from '../src/topology.ts'
import type { ExistingResource } from '../src/existing.ts'
import { kindOfExisting, kindOfResource } from '../src/existing.ts'

/** A VPC that exists, as the caller would describe it after list_existing_resources. */
const EXISTING_VPC: ExistingResource = {
  id: 'vpc-0a1b',
  type: 'huaweicloud_vpc',
  name: 'prod-vpc',
  cidr: '10.0.0.0/16',
  address: 'huaweicloud_vpc.prod',
}

/** A subnet of that VPC, already deployed. */
const EXISTING_SUBNET: ExistingResource = {
  id: 'subnet-9f8e',
  type: 'huaweicloud_vpc_subnet',
  name: 'legacy-web',
  cidr: '10.0.1.128/25',
  parent: 'vpc-0a1b',
}

describe('kindOfExisting', () => {
  it('accepts the terraform type', () => {
    expect(kindOfExisting('huaweicloud_vpc')).toBe('vpc')
    expect(kindOfExisting('huaweicloud_vpc_subnet')).toBe('subnet')
    expect(kindOfExisting('huaweicloud_compute_instance')).toBe('compute')
    expect(kindOfExisting('huaweicloud_rds_instance')).toBe('database')
  })

  it('treats a versioned type as the same kind', () => {
    expect(kindOfExisting('huaweicloud_vpc_v1')).toBe('vpc')
    expect(kindOfExisting('huaweicloud_compute_secgroup_v2')).toBe('security-group')
  })

  it('does not accept an RMS plural, which is not a terraform type', () => {
    // RMS answers `vpcs`, `cloudservers`, `securityGroups`. Those are a
    // different vocabulary: `kindOfExisting` answers for a `.tf` block, and an
    // RMS type reaches its kind through `kindOfResource`'s provider/type pair.
    for (const type of ['subnet', 'secgroup', 'ecs', 'rds', 'vpcs', 'cloudservers']) {
      expect(kindOfExisting(type), type).toBeUndefined()
    }
  })

  it('answers undefined for a type the topology is not about', () => {
    // Not `other`, and not drawn. A diagram is read by comparing boxes, so a
    // box that represents nothing the reader is comparing against is noise
    // exactly where the signal has to fit. The caller reports the type by name
    // instead — see `deriveTopology`'s `omitted`.
    expect(kindOfExisting('huaweicloud_something_new')).toBeUndefined()
    expect(kindOfExisting('huaweicloud_ces_alarmrule')).toBeUndefined()
    expect(kindOfExisting('huaweicloud_kms_key')).toBeUndefined()
  })
})

describe('existing resources as nodes', () => {
  it('adds one node per existing resource, marked as existing', () => {
    const topology = deriveTopology([], [EXISTING_VPC])
    expect(topology.nodes).toHaveLength(1)
    expect(topology.nodes[0]).toMatchObject({
      address: 'vpc-0a1b',
      kind: 'vpc',
      existing: true,
    })
  })

  it('marks configured resources as not existing', () => {
    const blocks = parseResources(`
resource "huaweicloud_vpc" "prod" {
  name = "prod-vpc"
  cidr = "10.0.0.0/16"
}
`)
    expect(deriveTopology(blocks).nodes[0]?.existing).toBe(false)
  })

  it('nests an existing resource under the parent the caller named', () => {
    // `parent` is a cloud ID and a cloud ID it names — no reference to resolve,
    // because nothing in the configuration declares either.
    const topology = deriveTopology([], [EXISTING_VPC, EXISTING_SUBNET])
    const vpc = topology.roots[0]
    expect(vpc?.address).toBe('vpc-0a1b')
    expect(vpc?.children.map(child => child.address)).toEqual(['subnet-9f8e'])
  })

  it('leaves an existing resource at the root when its parent is unknown', () => {
    const topology = deriveTopology([], [{ ...EXISTING_SUBNET, parent: 'vpc-missing' }])
    expect(topology.roots.map(node => node.address)).toEqual(['subnet-9f8e'])
  })

  it('shows the CIDR the caller supplied, and nothing it did not', () => {
    const topology = deriveTopology([], [EXISTING_SUBNET])
    // No gateway or AZ: an existing subnet's configuration is not this
    // deployment's to read, and inventing a value would put an unchecked fact on
    // the picture.
    expect(topology.nodes[0]?.facts).toEqual([{ key: 'cidr', value: '10.0.1.128/25' }])
  })
})

describe('a .tf reference to an existing resource', () => {
  /** A new subnet cut from the VPC that already exists. */
  const NEW_SUBNET = `
resource "huaweicloud_vpc_subnet" "web" {
  name       = "web"
  cidr       = "10.0.2.0/24"
  vpc_id     = huaweicloud_vpc.prod.id
  gateway_ip = "10.0.2.1"
}
`

  it('resolves through the terraform address the caller assigned', () => {
    // `huaweicloud_vpc.prod` is not declared — that VPC is not this
    // deployment's to create — so the reference has nothing in the file to
    // resolve against.
    const topology = deriveTopology(parseResources(NEW_SUBNET), [EXISTING_VPC])
    const subnet = topology.nodes.find(node => node.address === 'huaweicloud_vpc_subnet.web')
    expect(subnet?.parent).toBe('vpc-0a1b')
  })

  it('leaves the subnet at the root when no address was assigned', () => {
    // Without `address` nothing says which cloud VPC the reference means. A
    // guess here would nest the subnet into an arbitrary VPC, which looks
    // correct while being wrong.
    const noAddress = { ...EXISTING_VPC, address: undefined }
    const topology = deriveTopology(parseResources(NEW_SUBNET), [noAddress])
    const subnet = topology.nodes.find(node => node.address === 'huaweicloud_vpc_subnet.web')
    expect(subnet?.parent).toBeUndefined()
  })

  it('records the VPC above a resource placed in one of its subnets', () => {
    // A reader asking "where does this ECS live" means the VPC, not only the
    // subnet, so the chain is precomputed.
    const blocks = parseResources(`
${NEW_SUBNET}
resource "huaweicloud_compute_instance" "ecs" {
  name      = "app-1"
  flavor_id = "c7.large.2"
  image_id  = "img-1"
  network {
    uuid = huaweicloud_vpc_subnet.web.id
  }
}
`)
    const ecs = deriveTopology(blocks, [EXISTING_VPC]).nodes
      .find(node => node.address === 'huaweicloud_compute_instance.ecs')
    expect(ecs?.parent).toBe('huaweicloud_vpc_subnet.web')
    expect(ecs?.ancestors).toEqual(['huaweicloud_vpc_subnet.web', 'vpc-0a1b'])
  })
})

describe('a new subnet against one already deployed', () => {
  /** A subnet that collides with {@link EXISTING_SUBNET}'s range. */
  const OVERLAPPING = `
resource "huaweicloud_vpc_subnet" "web" {
  name       = "web"
  cidr       = "10.0.1.0/24"
  vpc_id     = huaweicloud_vpc.prod.id
  gateway_ip = "10.0.1.1"
}
`

  it('reports the overlap, which a .tf-only check cannot see', () => {
    // 10.0.1.0/24 contains 10.0.1.128/25, and that /25 is already deployed.
    const findings = deriveTopology(parseResources(OVERLAPPING), [EXISTING_VPC, EXISTING_SUBNET])
      .findings
    expect(findings.map(finding => finding.summary)).toEqual([
      expect.stringContaining('overlaps'),
    ])
  })

  it('says the range is not the design\'s to choose when one side exists', () => {
    const findings = deriveTopology(parseResources(OVERLAPPING), [EXISTING_VPC, EXISTING_SUBNET])
      .findings
    // The remedy differs from a collision between two new subnets: this one
    // cannot be fixed by renaming, because the other range is already taken.
    expect(findings[0]?.detail).toContain('already exists')
  })

  it('names the existing subnet by the name a reader sees', () => {
    const findings = deriveTopology(parseResources(OVERLAPPING), [EXISTING_VPC, EXISTING_SUBNET])
      .findings
    expect(findings[0]?.summary).toContain('legacy-web (existing)')
  })

  it('reports a subnet outside the range of a VPC that already exists', () => {
    // The VPC's range is not in the configuration either, so this needs the
    // existing side just as much as the overlap check does.
    const outside = `
resource "huaweicloud_vpc_subnet" "stray" {
  name       = "stray"
  cidr       = "192.168.1.0/24"
  vpc_id     = huaweicloud_vpc.prod.id
  gateway_ip = "192.168.1.1"
}
`
    const findings = deriveTopology(parseResources(outside), [EXISTING_VPC]).findings
    expect(findings.map(finding => finding.summary)).toEqual([
      expect.stringContaining('outside its VPC'),
    ])
  })

  it('says nothing when the new subnet sits in a free range', () => {
    const free = `
resource "huaweicloud_vpc_subnet" "web" {
  name       = "web"
  cidr       = "10.0.2.0/24"
  vpc_id     = huaweicloud_vpc.prod.id
  gateway_ip = "10.0.2.1"
}
`
    expect(deriveTopology(parseResources(free), [EXISTING_VPC, EXISTING_SUBNET]).findings)
      .toEqual([])
  })

  it('still checks rules in the configuration when nothing exists', () => {
    // The two check families take different inputs; the security-group half is
    // unaffected by the existing list, and must not be skipped because it came
    // in empty.
    const findings = deriveTopology(parseResources(`
resource "huaweicloud_networking_secgroup" "web" {
  name = "web-sg"
}
resource "huaweicloud_networking_secgroup_rule" "ssh" {
  direction         = "ingress"
  ethertype         = "IPv4"
  protocol          = "tcp"
  ports             = "22"
  remote_ip_prefix  = "0.0.0.0/0"
  security_group_id = huaweicloud_networking_secgroup.web.id
}
`), []).findings
    expect(findings.map(finding => finding.summary)).toEqual([
      expect.stringContaining('SSH'),
    ])
  })
})
describe('kindOfResource — the two vocabularies a caller may send', () => {
  it('reads a terraform type on its own', () => {
    // A resource written by hand, or one whose caller translated it itself.
    expect(kindOfResource({ type: 'huaweicloud_vpc' })).toBe('vpc')
    expect(kindOfResource({ type: 'huaweicloud_vpc_subnet' })).toBe('subnet')
    expect(kindOfResource({ type: 'huaweicloud_networking_secgroup' })).toBe('security-group')
    expect(kindOfResource({ type: 'huaweicloud_compute_instance' })).toBe('compute')
    expect(kindOfResource({ type: 'huaweicloud_rds_instance' })).toBe('database')
  })

  it('reads an RMS type only together with its provider', () => {
    // RMS reports the plural, per service. Alone it is not resolvable, and
    // resolving it would mean guessing which service meant it.
    expect(kindOfResource({ provider: 'vpc', type: 'vpcs' })).toBe('vpc')
    expect(kindOfResource({ provider: 'vpc', type: 'subnets' })).toBe('subnet')
    expect(kindOfResource({ provider: 'vpc', type: 'securityGroups' })).toBe('security-group')
    expect(kindOfResource({ provider: 'ecs', type: 'cloudservers' })).toBe('compute')
    // The pair is what disambiguates: `instances` is a database under rds.
    expect(kindOfResource({ provider: 'rds', type: 'instances' })).toBe('database')
  })

  it('refuses the same word under a provider that has no box for it', () => {
    // `instances` is also an API gateway's type. Answering "database" from the
    // word alone would put an APIG instance under a database's colour, and
    // guessing a shape is exactly what this module refuses to do.
    expect(kindOfResource({ provider: 'apig', type: 'instances' })).toBeUndefined()
  })

  it('answers undefined for a resource outside the picture', () => {
    // Real but not part of a network diagram — a key pair, an alarm rule, a
    // bucket. Reported by name rather than drawn as an invented shape.
    expect(kindOfResource({ provider: 'kps', type: 'keypairs' })).toBeUndefined()
    expect(kindOfResource({ type: 'huaweicloud_ces_alarmrule' })).toBeUndefined()
    expect(kindOfResource({ type: 'unknown_type_entirely' })).toBeUndefined()
  })
})
