/**
 * The checks `terraform validate` does not perform.
 *
 * Every test here is a design that `terraform validate` accepts. That is the
 * point of the module and the reason it exists, so the fixtures are written to
 * be schema-valid: correct attribute names, every required argument present,
 * every reference resolvable. Verified against huaweicloud provider 1.98.2 —
 * `terraform validate` answers `Success!` for all of them.
 *
 * What is being tested is which of those configurations a reviewer has to be
 * told about, and that the report names the resources involved.
 */

import { describe, it, expect } from 'vitest'

import { parseCidr } from '../src/network-checks.ts'
import { parseResources } from '../src/hcl.ts'
import { deriveTopology } from '../src/topology.ts'

/** Run the checks over a configuration, as the tool does. */
function findingsFor(hcl: string) {
  return deriveTopology(parseResources(hcl)).findings
}

/** A valid VPC wrapper around whatever subnets a test adds. */
function vpcWith(subnets: string, extra = ''): string {
  return `
resource "huaweicloud_vpc" "prod" {
  name = "prod-vpc"
  cidr = "10.0.0.0/16"
}
${subnets}
${extra}
`
}

describe('parseCidr', () => {
  it('reads a network and its prefix length', () => {
    expect(parseCidr('10.0.1.0/24')).toEqual({ base: 0x0a000100, prefix: 24 })
  })

  it('rejects text that is not a CIDR', () => {
    for (const text of ['10.0.1.0', '10.0.1.0/33', '10.0.1.256/24', 'not a cidr', '']) {
      expect(parseCidr(text), text).toBeUndefined()
    }
  })

  it('reads the all-addresses range', () => {
    expect(parseCidr('0.0.0.0/0')).toEqual({ base: 0, prefix: 0 })
  })
})

describe('the address plan', () => {
  it('passes a network with no problems', () => {
    const findings = findingsFor(vpcWith(`
resource "huaweicloud_vpc_subnet" "web" {
  name       = "web"
  cidr       = "10.0.1.0/24"
  vpc_id     = huaweicloud_vpc.prod.id
  gateway_ip = "10.0.1.1"
}
resource "huaweicloud_vpc_subnet" "db" {
  name       = "db"
  cidr       = "10.0.2.0/24"
  vpc_id     = huaweicloud_vpc.prod.id
  gateway_ip = "10.0.2.1"
}
`))
    expect(findings).toEqual([])
  })

  it('reports a subnet outside its VPC', () => {
    // Terraform accepts this because it never compares the two ranges; the
    // cloud refuses it at apply time, naming the VPC rather than the subnet.
    const findings = findingsFor(vpcWith(`
resource "huaweicloud_vpc_subnet" "stray" {
  name       = "stray"
  cidr       = "192.168.1.0/24"
  vpc_id     = huaweicloud_vpc.prod.id
  gateway_ip = "192.168.1.1"
}
`))
    expect(findings).toHaveLength(1)
    expect(findings[0]).toMatchObject({ severity: 'error' })
    expect(findings[0]?.summary).toContain('outside its VPC')
    expect(findings[0]?.addresses).toEqual([
      'huaweicloud_vpc_subnet.stray',
      'huaweicloud_vpc.prod',
    ])
  })

  it('reports a gateway address outside its own subnet', () => {
    // The subnet whose traffic has nowhere to go: this produces a working apply
    // and an unusable network.
    const findings = findingsFor(vpcWith(`
resource "huaweicloud_vpc_subnet" "web" {
  name       = "web"
  cidr       = "10.0.1.0/24"
  vpc_id     = huaweicloud_vpc.prod.id
  gateway_ip = "10.0.9.1"
}
`))
    expect(findings.map(finding => finding.summary)).toEqual([
      expect.stringContaining('gateway_ip'),
    ])
    expect(findings[0]?.severity).toBe('error')
  })

  it('reports two subnets whose ranges overlap', () => {
    // Identical CIDRs — the failure that costs the most, because the first
    // apply succeeds and the second fails against a subnet already created.
    const findings = findingsFor(vpcWith(`
resource "huaweicloud_vpc_subnet" "a" {
  name       = "a"
  cidr       = "10.0.2.0/24"
  vpc_id     = huaweicloud_vpc.prod.id
  gateway_ip = "10.0.2.1"
}
resource "huaweicloud_vpc_subnet" "b" {
  name       = "b"
  cidr       = "10.0.2.0/24"
  vpc_id     = huaweicloud_vpc.prod.id
  gateway_ip = "10.0.2.2"
}
`))
    expect(findings.map(finding => finding.summary)).toEqual([
      expect.stringContaining('overlaps'),
    ])
    expect(findings[0]?.addresses).toEqual([
      'huaweicloud_vpc_subnet.a',
      'huaweicloud_vpc_subnet.b',
    ])
  })

  it('reports a partial overlap, not only an identical range', () => {
    // 10.0.2.128/25 sits inside 10.0.2.0/24 — different prefixes, same space.
    const findings = findingsFor(vpcWith(`
resource "huaweicloud_vpc_subnet" "wide" {
  name       = "wide"
  cidr       = "10.0.2.0/24"
  vpc_id     = huaweicloud_vpc.prod.id
  gateway_ip = "10.0.2.1"
}
resource "huaweicloud_vpc_subnet" "narrow" {
  name       = "narrow"
  cidr       = "10.0.2.128/25"
  vpc_id     = huaweicloud_vpc.prod.id
  gateway_ip = "10.0.2.129"
}
`))
    expect(findings.map(finding => finding.summary)).toEqual([
      expect.stringContaining('overlaps'),
    ])
  })

  it('does not report the same range in two different VPCs', () => {
    // Separate routing domains may share an address plan legitimately. Reporting
    // it would be a guess about which network the subnets join.
    const findings = findingsFor(`
resource "huaweicloud_vpc" "one" {
  name = "one"
  cidr = "10.0.0.0/16"
}
resource "huaweicloud_vpc" "two" {
  name = "two"
  cidr = "10.0.0.0/16"
}
resource "huaweicloud_vpc_subnet" "a" {
  name       = "a"
  cidr       = "10.0.1.0/24"
  vpc_id     = huaweicloud_vpc.one.id
  gateway_ip = "10.0.1.1"
}
resource "huaweicloud_vpc_subnet" "b" {
  name       = "b"
  cidr       = "10.0.1.0/24"
  vpc_id     = huaweicloud_vpc.two.id
  gateway_ip = "10.0.1.1"
}
`)
    expect(findings).toEqual([])
  })

  it('stays silent about a CIDR it cannot resolve', () => {
    // `var.cidr` has no value before terraform runs. Guessing would produce a
    // finding about a range the deployment may not have.
    const findings = findingsFor(vpcWith(`
resource "huaweicloud_vpc_subnet" "web" {
  name       = "web"
  cidr       = var.web_cidr
  vpc_id     = huaweicloud_vpc.prod.id
  gateway_ip = "10.0.1.1"
}
`))
    expect(findings.map(finding => finding.summary)).not.toContainEqual(
      expect.stringContaining('overlap'),
    )
  })

  it('reports a single CIDR as both problems when it is both', () => {
    // Overlapping AND its gateway outside: two independent facts, both true.
    const findings = findingsFor(vpcWith(`
resource "huaweicloud_vpc_subnet" "a" {
  name       = "a"
  cidr       = "10.0.2.0/24"
  vpc_id     = huaweicloud_vpc.prod.id
  gateway_ip = "10.0.2.1"
}
resource "huaweicloud_vpc_subnet" "b" {
  name       = "b"
  cidr       = "10.0.2.0/24"
  vpc_id     = huaweicloud_vpc.prod.id
  gateway_ip = "10.0.9.1"
}
`))
    const summaries = findings.map(finding => finding.summary)
    expect(summaries.some(summary => summary.includes('overlaps'))).toBe(true)
    expect(summaries.some(summary => summary.includes('gateway_ip'))).toBe(true)
  })
})

describe('security-group rules', () => {
  /** A group plus one rule, to test that rule's exposure. */
  function groupWithRule(rule: string): string {
    return `
resource "huaweicloud_networking_secgroup" "web" {
  name = "web-sg"
}
resource "huaweicloud_networking_secgroup_rule" "r" {
  direction         = "ingress"
  ethertype         = "IPv4"
  protocol          = "tcp"
${rule}
  security_group_id = huaweicloud_networking_secgroup.web.id
}
`
  }

  it('reports SSH open to the world', () => {
    const findings = findingsFor(groupWithRule(`  ports            = "22"
  remote_ip_prefix = "0.0.0.0/0"`))
    expect(findings).toHaveLength(1)
    expect(findings[0]).toMatchObject({ severity: 'warning' })
    expect(findings[0]?.summary).toContain('SSH')
    expect(findings[0]?.addresses).toEqual(['huaweicloud_networking_secgroup_rule.r'])
  })

  it('says nothing about HTTPS open to the world', () => {
    // Serving 443 is the whole point of a public web tier. Reporting it would
    // bury the findings that matter.
    const findings = findingsFor(groupWithRule(`  ports            = "443"
  remote_ip_prefix = "0.0.0.0/0"`))
    expect(findings).toEqual([])
  })

  it('finds a sensitive port inside a list', () => {
    const findings = findingsFor(groupWithRule(`  ports            = "80,3306,443"
  remote_ip_prefix = "0.0.0.0/0"`))
    expect(findings.map(finding => finding.summary)).toEqual([
      expect.stringContaining('MySQL'),
    ])
  })

  it('finds a sensitive port inside a range', () => {
    const findings = findingsFor(groupWithRule(`  ports            = "1-1024"
  remote_ip_prefix = "0.0.0.0/0"`))
    expect(findings[0]?.summary).toContain('SSH')
    // 22 is inside 1-1024 and 3389 is not: the range is read, not assumed.
    expect(findings[0]?.summary).not.toContain('RDP')
  })

  it('reports a rule with no ports at all, because that is every port', () => {
    const findings = findingsFor(groupWithRule(`  remote_ip_prefix = "0.0.0.0/0"`))
    expect(findings).toHaveLength(1)
    expect(findings[0]?.summary).toContain('every port')
  })

  it('says nothing when the source is restricted', () => {
    const findings = findingsFor(groupWithRule(`  ports            = "22"
  remote_ip_prefix = "203.0.113.0/24"`))
    expect(findings).toEqual([])
  })

  it('says nothing about egress, which every working subnet needs', () => {
    // Egress to 0.0.0.0/0 is how a subnet reaches package mirrors and APIs.
    const findings = findingsFor(`
resource "huaweicloud_networking_secgroup" "web" {
  name = "web-sg"
}
resource "huaweicloud_networking_secgroup_rule" "out" {
  direction         = "egress"
  ethertype         = "IPv4"
  protocol          = "tcp"
  ports             = "22"
  remote_ip_prefix  = "0.0.0.0/0"
  security_group_id = huaweicloud_networking_secgroup.web.id
}
`)
    expect(findings).toEqual([])
  })
})

describe('the report as a whole', () => {
  it('puts errors before warnings', () => {
    // A reader stops at the first screen; the unbuildable problems belong at
    // the top.
    const findings = findingsFor(vpcWith(`
resource "huaweicloud_vpc_subnet" "stray" {
  name       = "stray"
  cidr       = "192.168.1.0/24"
  vpc_id     = huaweicloud_vpc.prod.id
  gateway_ip = "192.168.1.1"
}
`, `
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
`))
    expect(findings.map(finding => finding.severity)).toEqual(['error', 'warning'])
  })
})