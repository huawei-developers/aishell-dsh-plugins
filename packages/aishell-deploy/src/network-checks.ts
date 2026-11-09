/**
 * The design checks the provider's own validation does not perform.
 *
 * ## Why these exist
 *
 * `terraform validate` checks each block against the provider's schema and
 * settles every reference. It does NOT check the properties that hold ACROSS
 * blocks — the provider reports `Success!` for all of the following:
 *
 *   - two subnets in one VPC with the same CIDR
 *   - a subnet whose CIDR falls outside its VPC
 *   - a `gateway_ip` outside its own subnet
 *   - a security-group rule opening SSH to `0.0.0.0/0`
 *
 * Each of those produces a working `apply` and a network that does not do what
 * its author meant. Nothing in terraform's toolchain reports them at plan time
 * either: they are facts about the assembled network, and only the assembly
 * knows them.
 *
 * ## Why findings and not errors
 *
 * A finding is reported and the deployment continues. Refusing would be wrong
 * in two directions. Some are legitimate: a peering or a load balancer
 * requires its own subnet, and a bastion host may genuinely need SSH from
 * anywhere. And the model cannot repair what it is not told about — an error
 * that stops the tool before it writes the diagram leaves the reader with no
 * picture and no explanation. So the diagram is produced, and the problems
 * ride beside it.
 *
 * @module @huaweidevtools/aishell-dsh-deploy/network-checks
 */

import type { Finding } from './topology.ts'
import { literalOf, referencesOf } from './hcl.ts'
import type { ResourceBlock } from './hcl.ts'
import { kindOfResource } from './existing.ts'
import type { ExistingResource } from './existing.ts'

/** One IPv4 CIDR, as the numbers it denotes. */
interface Cidr {
  /** The address as a 32-bit unsigned integer. */
  readonly base: number
  /** How many of the high bits are the network. */
  readonly prefix: number
}

/**
 * Parse a dotted-quad CIDR into its network number and prefix length.
 *
 * @param text - a value such as `10.0.1.0/24`.
 * @returns the parsed CIDR, or `undefined` when the text is not one.
 */
export function parseCidr(text: string): Cidr | undefined {
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\/(\d{1,2})$/.exec(text.trim())
  if (match === null) return undefined
  const octets = match.slice(1, 5).map(part => Number(part))
  if (octets.some(octet => octet > 255)) return undefined
  const prefix = Number(match[5])
  if (prefix > 32) return undefined
  const base = octets.reduce((acc, octet) => (acc * 256) + octet, 0)
  return { base: base >>> 0, prefix }
}

/** The first and last address a CIDR denotes, both inclusive. */
function range(cidr: Cidr): { readonly first: number, readonly last: number } {
  // `>>> 0` keeps every step unsigned; without it a /0 (mask 0) goes negative.
  const mask = cidr.prefix === 0 ? 0 : (0xffffffff << (32 - cidr.prefix)) >>> 0
  const first = (cidr.base & mask) >>> 0
  const size = 2 ** (32 - cidr.prefix)
  return { first, last: (first + size - 1) >>> 0 }
}

/** Whether two CIDRs share any address. */
function overlaps(a: Cidr, b: Cidr): boolean {
  const left = range(a)
  const right = range(b)
  return left.first <= right.last && right.first <= left.last
}

/** Whether `inner` is fully inside `outer`. */
function contains(outer: Cidr, inner: Cidr): boolean {
  const a = range(outer)
  const b = range(inner)
  return b.first >= a.first && b.last <= a.last
}

/** Render an address and prefix back as text, for a finding. */
function formatCidr(cidr: Cidr): string {
  const mask = cidr.prefix === 0 ? 0 : (0xffffffff << (32 - cidr.prefix)) >>> 0
  const base = (cidr.base & mask) >>> 0
  const octets = [24, 16, 8, 0].map(shift => (base >>> shift) & 0xff)
  return `${octets.join('.')}/${cidr.prefix}`
}

/** Ports a rule opens that should not face the whole internet. */
const SENSITIVE_PORTS = new Map<string, string>([
  ['22', 'SSH'],
  ['23', 'Telnet'],
  ['3389', 'RDP (Windows remote desktop)'],
  ['3306', 'MySQL'],
  ['5432', 'PostgreSQL'],
  ['6379', 'Redis'],
  ['27017', 'MongoDB'],
  ['9200', 'Elasticsearch'],
])

/**
 * Every design problem the configuration contains, most severe first.
 *
 * Two families, and they need different inputs. The security-group checks read
 * the configuration alone — a rule's exposure is a fact about that rule. The
 * address-plan checks need the account too: whether a new subnet collides with
 * one already deployed cannot be answered from the file that does not mention
 * it.
 *
 * @param blocks - the deployment's resource blocks.
 * @param existing - the resources the caller reported as already present.
 * @param byAddress - every known node, by terraform address, as the topology
 *   derived it. Only its keys are read, so the node ids a finding names agree
 *   with the ones a reader can find in the recorded deployment.
 * @returns the findings, most severe first, each naming its resources.
 */
export function findProblems(
  blocks: readonly ResourceBlock[],
  byAddress: ReadonlyMap<string, unknown>,
  existing: readonly ExistingResource[] = [],
): Finding[] {
  const findings: Finding[] = []
  findings.push(...checkSubnets(blocks, byAddress, existing))
  findings.push(...checkSecurityGroups(blocks))
  return findings.sort((a, b) => (a.severity === b.severity ? 0 : a.severity === 'error' ? -1 : 1))
}

/**
 * The subnets an existing-resource list contributes, already placed.
 *
 * Only what the caller supplied: a CIDR it did not give is a subnet whose range
 * this module cannot know, and it takes no part in the overlap comparison —
 * reporting a collision against an unknown range would be an invention.
 *
 * The `vpc` is the cloud ID of the parent, which is also the node address the
 * topology gives an existing VPC. A new subnet's reference is normalised to the
 * same address before the comparison, so both sides name one thing one way.
 *
 * @param existing - the resources the caller reported.
 * @returns one entry per subnet with a CIDR.
 */
function existingSubnets(existing: readonly ExistingResource[]): Placed[] {
  const placed: Placed[] = []
  for (const resource of existing) {
    if (kindOfResource(resource) !== 'subnet') continue
    const cidr = resource.cidr === undefined ? undefined : parseCidr(resource.cidr)
    if (cidr === undefined) continue
    placed.push({
      address: `${resource.name ?? resource.id} (existing)`,
      cidr,
      vpc: resource.parent,
      existing: true,
    })
  }
  return placed
}

/**
 * Problems that make the address plan itself unsound.
 *
 * Three checks, all of which need more than one block to see:
 *
 *   - a subnet's CIDR outside its VPC's, which terraform accepts and the
 *     cloud rejects at apply time with a message about the VPC, not the subnet;
 *   - a gateway address outside its own subnet, which produces a subnet
 *     nothing can route through;
 *   - two subnets sharing any address, which is the one that fails hardest —
 *     the second `apply` fails, after the first subnet already exists.
 *
 * @param blocks - the deployment's resource blocks.
 * @param byAddress - the known node addresses, for naming references.
 * @returns findings for the address plan.
 */
/** One subnet the checks can compare: an address, a range, and its VPC. */
interface Placed {
  readonly address: string
  readonly cidr: Cidr
  readonly vpc: string | undefined
  /** True for a subnet that already exists, so a finding can say so. */
  readonly existing?: boolean
}

function checkSubnets(
  blocks: readonly ResourceBlock[],
  byAddress: ReadonlyMap<string, unknown>,
  existing: readonly ExistingResource[] = [],
): Finding[] {
  /**
   * The terraform address a VPC reference resolved to, when the VPC is not in
   * this configuration. An existing VPC is keyed in `vpcCidr` under both its
   * cloud id and the address the caller assigned, so a subnet written to reuse
   * one can be compared against it AND against existing subnets that name the
   * same VPC by cloud id.
   */
  const existingVpcByAddress = new Map<string, string>()
  for (const resource of existing) {
    if (kindOfResource(resource) !== 'vpc' || resource.address === undefined) continue
    existingVpcByAddress.set(resource.address, resource.id)
  }
  const findings: Finding[] = []
  const vpcCidr = new Map<string, Cidr>()

  for (const block of blocks) {
    if (block.type !== 'huaweicloud_vpc' && block.type !== 'huaweicloud_vpc_v1') continue
    const cidr = literalOf(block.body, 'cidr')
    const parsed = cidr === undefined ? undefined : parseCidr(cidr)
    if (parsed !== undefined) vpcCidr.set(`${block.type}.${block.name}`, parsed)
  }

  // An existing VPC's range is the one a new subnet has to fit into, and it is
  // the range the containment check needs. Keyed by the terraform address the
  // caller assigned, which is what a `.tf` reference resolves to.
  for (const resource of existing) {
    if (kindOfResource(resource) !== 'vpc' || resource.cidr === undefined) continue
    const parsed = parseCidr(resource.cidr)
    if (parsed === undefined) continue
    for (const key of [resource.address, resource.id]) {
      if (key !== undefined) vpcCidr.set(key, parsed)
    }
  }

  /** Subnets that resolved to a concrete CIDR, for the overlap comparison. */
  const placed: Placed[] = []

  for (const block of blocks) {
    if (block.type !== 'huaweicloud_vpc_subnet' && block.type !== 'huaweicloud_vpc_subnet_v1') continue
    const address = `${block.type}.${block.name}`
    const cidrText = literalOf(block.body, 'cidr')
    const cidr = cidrText === undefined ? undefined : parseCidr(cidrText)
    if (cidr === undefined) continue

    // Normalise the resolved reference to the node address an existing subnet
    // would name, so the overlap comparison compares like with like.
    const referenced = referencesOf(block.body).find(ref => vpcCidr.has(ref))
    const vpc = referenced === undefined ? undefined : (existingVpcByAddress.get(referenced) ?? referenced)
    if (vpc !== undefined) {
      const parent = vpcCidr.get(vpc)
      if (parent !== undefined && !contains(parent, cidr)) {
        findings.push({
          severity: 'error',
          summary: `${address} (${formatCidr(cidr)}) is outside its VPC ${vpc} (${formatCidr(parent)})`,
          detail:
            'A subnet must lie entirely inside its VPC address range. Terraform accepts this '
            + 'because it never compares the two, and the cloud refuses it at apply time with a '
            + 'message about the VPC rather than the subnet.',
          addresses: [address, vpc],
        })
      }
    }

    const gateway = literalOf(block.body, 'gateway_ip')
    const gatewayCidr = gateway === undefined ? undefined : parseCidr(`${gateway}/32`)
    if (gatewayCidr !== undefined && !contains(cidr, gatewayCidr)) {
      findings.push({
        severity: 'error',
        summary: `${address} has a gateway_ip (${gateway}) outside its own CIDR (${formatCidr(cidr)})`,
        detail:
          'Every host in the subnet reaches the network through this address. Outside the '
          + 'subnet range there is nothing to route through, and the subnet is unusable.',
        addresses: [address],
      })
    }

    placed.push({ address, cidr, vpc })
  }

  // Existing subnets join the same list, so a new subnet is compared against
  // what is already deployed and not only against its neighbours in the file.
  placed.push(...existingSubnets(existing))

  // Overlap is compared per VPC: two subnets in different VPCs may legitimately
  // share a range, because those ranges are separate routing domains.
  for (let i = 0; i < placed.length; i += 1) {
    for (let j = i + 1; j < placed.length; j += 1) {
      const a = placed[i]
      const b = placed[j]
      if (a === undefined || b === undefined) continue
      if (!overlaps(a.cidr, b.cidr)) continue
      const sameVpc = a.vpc !== undefined && a.vpc === b.vpc
      // Without a resolved VPC on either, the two could be unrelated; reporting
      // them as overlapping would be a guess about which network they join.
      if (!sameVpc) continue
      const involvesExisting = a.existing === true || b.existing === true
      findings.push({
        severity: 'error',
        summary: `${a.address} (${formatCidr(a.cidr)}) overlaps ${b.address} (${formatCidr(b.cidr)})`,
        detail: involvesExisting
          ? 'One of these subnets already exists, so its range is not this design\'s to choose. '
            + 'Two subnets in one VPC cannot share addresses: move the new subnet to a free range '
            + 'inside the VPC, or reuse the existing one instead of cutting another.'
          : 'Two subnets in one VPC cannot share addresses. This is the failure that costs the '
            + 'most: the first apply succeeds, and the second fails once the first subnet exists '
            + 'and cannot be moved.',
        addresses: [a.address, b.address]
          .filter(address => !address.endsWith(' (existing)')),
      })
    }
  }

  // The map parameter exists so the caller's node list stays the single source
  // of addresses; a finding never names an address the topology does not have.
  void byAddress
  return findings
}

/**
 * Rules that expose a service to the whole internet.
 *
 * Only `ingress` is considered. `egress` to `0.0.0.0/0` is the default that
 * every working subnet needs, so reporting it would bury the real findings.
 *
 * `ports` is a string in this provider (`"22"`, `"80,443"`, `"1-1024"`), so a
 * range is expanded only when it is small enough to be worth listing; a rule
 * that opens a wide range is reported by the range itself.
 *
 * @param blocks - the deployment's resource blocks.
 * @returns findings for world-open rules.
 */
function checkSecurityGroups(blocks: readonly ResourceBlock[]): Finding[] {
  const findings: Finding[] = []
  for (const block of blocks) {
    if (!block.type.startsWith('huaweicloud_networking_secgroup_rule')) continue
    const address = `${block.type}.${block.name}`
    const direction = literalOf(block.body, 'direction')
    if (direction !== 'ingress') continue
    const remote = literalOf(block.body, 'remote_ip_prefix')
    if (remote !== '0.0.0.0/0' && remote !== '::/0') continue

    const ports = literalOf(block.body, 'ports')
    if (ports === undefined) {
      // No port list means every port. That is at least as serious as a named
      // service, so it is reported as its own case rather than skipped.
      findings.push({
        severity: 'warning',
        summary: `${address} admits every port from ${remote}`,
        detail:
          'A rule with no `ports` value opens the whole protocol range to the internet. '
          + 'Restrict it to the ports the workload actually serves.',
        addresses: [address],
      })
      continue
    }

    const exposed = sensitivePortsIn(ports)
    if (exposed.length === 0) continue
    findings.push({
      severity: 'warning',
      summary: `${address} admits ${exposed.join(', ')} from ${remote}`,
      detail:
        'These ports are administrative or database endpoints. Open to 0.0.0.0/0 they are '
        + 'reachable by anyone who can route to the address. Restrict `remote_ip_prefix` to '
        + 'the office or bastion range, or reach the service through a jump host.',
      addresses: [address],
    })
  }
  return findings
}

/**
 * Which sensitive services a `ports` value names.
 *
 * @param ports - the rule's port list: `"22"`, `"80,443"`, or `"1-1024"`.
 * @returns `service (port)` labels, in ascending port order, so the finding
 *   names the exact port and not only the service — a reader fixing the rule
 *   needs the number.
 */
function sensitivePortsIn(ports: string): string[] {
  const exposed: { port: number, service: string }[] = []
  const see = (port: number, service: string): void => {
    if (exposed.some(entry => entry.port === port)) return
    exposed.push({ port, service })
  }
  for (const part of ports.split(',')) {
    const piece = part.trim()
    if (piece === '') continue
    const rangeMatch = /^(\d+)\s*-\s*(\d+)$/.exec(piece)
    if (rangeMatch !== null) {
      const from = Number(rangeMatch[1])
      const to = Number(rangeMatch[2])
      for (const [port, service] of SENSITIVE_PORTS) {
        const value = Number(port)
        if (value >= from && value <= to) see(value, service)
      }
      continue
    }
    const named = SENSITIVE_PORTS.get(piece)
    if (named !== undefined) see(Number(piece), named)
  }
  return exposed
    .sort((a, b) => a.port - b.port)
    .map(entry => `${entry.service} (${entry.port})`)
}