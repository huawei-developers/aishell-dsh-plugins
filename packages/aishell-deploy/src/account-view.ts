/**
 * Reading the account as the three things an architecture diagram shows.
 *
 * ## The three layers, and why they are separate
 *
 * A network diagram is not one graph. It is three, and a reader looks at each
 * for a different question:
 *
 *   1. **Placement** — where a thing lives. A server is in a subnet, a subnet is
 *      in a VPC. This is drawn as nesting: the box is inside the other box.
 *   2. **Attachment** — what hangs off a thing. An EIP belongs to a load
 *      balancer, a disk belongs to a server, a CCE node runs on a server. This
 *      is also nesting, for the same reason: it is the same kind of fact, and a
 *      line would say "related" where the truth is "part of".
 *   3. **Policy** — whether traffic may flow. A security group admits another
 *      security group on a port. This is the only layer that is genuinely an
 *      edge, and the only one where direction and port carry meaning.
 *
 * A security group is NOT a fourth kind of node. It is a property of the thing
 * it guards — drawn inside that thing's box — and separately a vertex of the
 * policy graph. Drawing `server → security-group` as a line says the two are
 * peers, which is false, and loses the real edges between groups entirely.
 *
 * @module @huaweidevtools/aishell-dsh-deploy/account-view
 */

import { flattenProperties } from './existing-topology.ts'
import type { InventoryResource } from './existing-topology.ts'

/** One resource as the inventory reports it. */
export type AccountResource = InventoryResource

/** A security group's rule that admits traffic from another security group. */
export interface PolicyEdge {
  /** The group doing the admitting. */
  readonly to: string
  /** The group whose members are admitted. */
  readonly from: string
  /** `ingress` or `egress`, as the provider reports it. */
  readonly direction: string
  /** `tcp`, `udp`, `icmp` or `any`. */
  readonly protocol: string
  /** The port range, or `undefined` for all ports. */
  readonly ports: string | undefined
}

/** The three layers, resolved. */
export interface AccountView {
  /** Resource id → the id of the box it is drawn inside. */
  readonly parentOf: ReadonlyMap<string, string>
  /** Resource id → the security group names that guard it. */
  readonly guardsOf: ReadonlyMap<string, readonly string[]>
  /** The policy edges between groups, deduplicated. */
  readonly policies: readonly PolicyEdge[]
  /** Groups that take part in a policy edge, and so belong in the policy band. */
  readonly policyGroups: ReadonlySet<string>
}

/**
 * Read a string-valued property, unwrapping the JSON encoding RMS uses.
 *
 * The inventory ships some ids as `"[\"…\"]"` — a JSON array inside a string —
 * and a plain comparison against an id never matches. One unwrap is enough:
 * the provider does not double-encode.
 *
 * @param value - the property value.
 * @returns the id it holds, or `undefined`.
 */
function idOf(value: unknown): string | undefined {
  if (typeof value === 'string') {
    const trimmed = value.trim()
    if (trimmed.startsWith('[')) {
      try {
        const parsed = JSON.parse(trimmed) as unknown
        if (Array.isArray(parsed) && typeof parsed[0] === 'string') return parsed[0]
      } catch {
        return trimmed
      }
    }
    return trimmed === '' ? undefined : trimmed
  }
  if (Array.isArray(value) && typeof value[0] === 'string') return value[0]
  return undefined
}

/**
 * The attribute names that mean "this is drawn inside that".
 *
 * Two kinds, and both are nesting:
 *
 *   - **Placement** — `vpc_id`, `subnet_id`, `networkId`. Where a thing lives.
 *   - **Attachment** — `serverID`, `host_id`, `clusterUID`, and an EIP's
 *     `associateInstanceId`. What a thing is part of.
 *
 * Both answer the same question for the reader ("what does this belong to"),
 * and both are drawn the same way. Keeping one table rather than two is what
 * lets a service this build has never seen nest correctly: it only has to name
 * the relationship the way the others do.
 *
 * Ranked: a more specific container wins. A server names both its VPC and its
 * subnet, and the subnet is where it lives.
 *
 * ## Every entry points from the member to its container
 *
 * The direction is part of the meaning, not a detail. A balancer lists its EIPs
 * in `eips[].eip_id`, which reads like a container holding a member — but the
 * EIP is the one that names the balancer, through `associateInstanceId`, and
 * only the EIP's property says where it belongs. Reading the balancer's list as
 * placement put the balancer inside its own address.
 *
 * So an attribute belongs here only when it says "I am part of that". A
 * container that lists its members does not.
 */
const NESTS_IN: readonly { readonly match: RegExp, readonly rank: number }[] = [
  { match: /vpc[._]?id$/i, rank: 1 },
  { match: /(subnet|network)[._]?(id|uid)s?$/i, rank: 2 },
  { match: /^(vnic\.)?deviceId$/i, rank: 3 },
  // A disk names the machine it is attached to as `attachments.serverId`,
  // which the flattening keeps under the `attachments` path.
  { match: /(^|\.)(server|host)[._]?id$/i, rank: 4 },
  { match: /cluster(uid|[._]?id)$/i, rank: 4 },
  { match: /^associateInstanceId$/i, rank: 4 },
  // A listener belongs to the balancer that owns it. The provider writes this
  // as `loadbalancers: [{ id }]`, and the flattening turns it into
  // `loadbalancers.id`.
  { match: /^loadbalancers?[._]id$/i, rank: 4 },
]

/**
 * The attribute names that name a security group guarding this resource.
 *
 * These do NOT nest and do NOT become edges: a group is a property of the thing
 * it guards, so it is drawn as text inside that thing's box.
 */
const GUARDS_BY: readonly RegExp[] = [
  /security[._]?group[._]?id$/i,
  /secgroup$/i,
]

/**
 * How many resources must name a container before it counts as one.
 *
 * Two is enough to tell "everything inside me points here" from "one thing
 * mentioned me". A NAT gateway is named by the single EIP attached to it and is
 * still a thing placed inside a VPC; a VPC is named by every subnet, server and
 * load balancer it holds and is a root.
 */
const CONTAINER_REFERENTS = 2

/**
 * How specifically an attribute names a container, 0 for none.
 *
 * @param attribute - a dotted property path.
 * @returns the rank, higher being more specific.
 */
export function nestRank(attribute: string): number {
  // A `description` is free text a person or a controller wrote, and an id
  // inside it is a remark about the resource, not a structural field. The
  // Kubernetes-managed ELB listener is the case: its description carries the
  // cluster it fronts — `{"cluster_id": "…"}` — and reading that as "the
  // listener belongs to the cluster" puts a load balancer's front end inside a
  // container it merely serves.
  //
  // Stated as a rule about the field rather than about that service: any
  // structure inferred from free text is a guess about what someone meant.
  if (attribute === 'description' || attribute.startsWith('description.')) return 0

  for (const { match, rank } of NESTS_IN) {
    if (match.test(attribute)) return rank
  }
  return 0
}

/**
 * Whether an attribute names a security group.
 *
 * @param attribute - a dotted property path.
 * @returns whether it does.
 */
export function isGuardAttribute(attribute: string): boolean {
  return GUARDS_BY.some(match => match.test(attribute))
}

/**
 * Read the placement and attachment layer.
 *
 * @param resources - the account's resources.
 * @returns resource id → the id of its container.
 */
export function containment(
  resources: readonly AccountResource[],
): Map<string, string> {
  const byId = new Map(resources.map(resource => [resource.id, resource]))
  const parentOf = new Map<string, string>()
  const rankOf = new Map<string, number>()

  /** Record a placement, keeping the most specific one. */
  const place = (child: string, parent: string, rank: number): void => {
    if (child === parent || !byId.has(parent)) return
    if (rank <= (rankOf.get(child) ?? 0)) return
    parentOf.set(child, parent)
    rankOf.set(child, rank)
  }

  // Properties are flattened, not read from the top level: the provider nests
  // links (`vnic.vpcId`, `eips.eip_id`) and encodes some ids as JSON strings,
  // and a walk that only looked at the surface would miss both — which is how
  // an EIP's VPC went unseen.
  for (const resource of resources) {
    for (const [attribute, value] of flattenProperties(resource.properties ?? {})) {
      const rank = nestRank(attribute)
      if (rank === 0) continue
      const target = idOf(value)
      if (target === undefined) continue
      place(resource.id, target, rank)
    }
  }

  // ── Placement read backwards ────────────────────────────────────────────
  //
  // Some resources state no location of their own but are named BY one that
  // does. A NAT gateway reports only its spec, while the EIP attached to it
  // carries the gateway's VPC in `vnic.vpcId` — the same VPC the gateway is
  // actually in, recorded on the other side of the relationship.
  //
  // So a resource that ended up with no container inherits the container of
  // anything that names it. The rank is the naming attribute's own, so a
  // subnet named by a server still nests as a subnet and a VPC as a VPC.
  const namedBy = new Map<string, { readonly from: string, readonly rank: number }[]>()
  for (const resource of resources) {
    for (const [attribute, value] of flattenProperties(resource.properties ?? {})) {
      const rank = nestRank(attribute)
      if (rank === 0) continue
      const target = idOf(value)
      if (target === undefined || target === resource.id) continue
      if (!byId.has(target)) continue
      const listed = namedBy.get(target) ?? []
      // One referrer per SOURCE, not per attribute: an EIP names its NAT
      // gateway twice (`vnic.deviceId` and `associateInstanceId`), and counting
      // that as two referrers would make a single attachment look like a
      // container everything points at.
      if (listed.some(entry => entry.from === resource.id)) continue
      namedBy.set(target, [...listed, { from: resource.id, rank }])
    }
  }

  for (const [named, referrers] of namedBy) {
    if (parentOf.has(named)) continue

    // A resource many others name as their container IS a container, and a
    // container is a root: it does not get placed inside the things it holds.
    //
    // This is the check that keeps the nesting upright. A VPC names no
    // container of its own — it is one — so "it states no placement" is true
    // and would let the reverse pass put it inside a gateway that happens to
    // mention its id. Counting how many name it is what separates "says
    // nothing about where it is" from "is where everything else is".
    if (referrers.length >= CONTAINER_REFERENTS) continue

    // The inherited container must not be something this resource already
    // holds. Following the chain can walk back down into the resource itself —
    // a VPC named by an EIP whose gateway the VPC also contains is the case —
    // and that would nest a container inside its own contents.
    const inherited = inheritedContainer(byId.get(named)!, resources, parentOf, namedBy)
    if (inherited === undefined || inherited === named) continue
    if (holdsTransitively(named, inherited, parentOf)) continue
    // The rank is what the naming attribute said: a subnet named by a server
    // nests as a subnet even though the evidence came from elsewhere.
    const rank = referrers.reduce((best, referrer) => Math.max(best, referrer.rank), 0)
    place(named, inherited, rank)
  }

  // A container must not sit inside its own descendant. Dropping the placement
  // leaves the box at the root, which a reader can see and correct.
  //
  // The copy is required, not decorative: this loop deletes from `parentOf`
  // while walking it, and a live iterator skips the entry that follows a
  // deletion — which would leave half the cycles unbroken.
  // eslint-disable-next-line unicorn/no-useless-spread
  for (const [child] of [...parentOf]) {
    const seen = new Set<string>([child])
    let cursor = parentOf.get(child)
    while (cursor !== undefined) {
      if (seen.has(cursor)) {
        parentOf.delete(child)
        break
      }
      seen.add(cursor)
      cursor = parentOf.get(cursor)
    }
  }

  return parentOf
}


/**
 * Every container a resource's properties name, most specific first.
 *
 * A resource may state more than one placement, and they are all true: an EIP
 * attached to a NAT gateway names the gateway (it is drawn inside it) AND the
 * VPC it sits in. Only one of them can be the box it is drawn in, but the
 * others still say where it lives — which is what a resource that states no
 * placement of its own can borrow.
 *
 * @param resource - the resource.
 * @returns the container ids, ordered by how specific the attribute was.
 */
function allContainers(resource: AccountResource): { id: string, rank: number }[] {
  const found: { id: string, rank: number }[] = []
  for (const [attribute, value] of flattenProperties(resource.properties ?? {})) {
    const rank = nestRank(attribute)
    if (rank === 0) continue
    const target = idOf(value)
    if (target === undefined || target === resource.id) continue
    found.push({ id: target, rank })
  }
  return found.sort((a, b) => b.rank - a.rank)
}

/**
 * The container a resource is in, following the naming chain when needed.
 *
 * ## Why one hop is not enough
 *
 * A NAT gateway reports only its spec. The EIP attached to it knows two things:
 * that it belongs to the gateway, and that the gateway sits in a VPC. The
 * gateway's placement is therefore one link away — it is in whatever VPC the
 * thing that names it names.
 *
 * @param resource - the resource whose container is wanted.
 * @param resources - everything in the account.
 * @param parentOf - the placement resolved so far.
 * @param namedBy - which resources name each other.
 * @returns the container id, or `undefined` when the chain leads nowhere.
 */
function inheritedContainer(
  resource: AccountResource,
  resources: readonly AccountResource[],
  parentOf: ReadonlyMap<string, string>,
  namedBy: ReadonlyMap<string, readonly { readonly from: string, readonly rank: number }[]>,
): string | undefined {
  const byId = new Map(resources.map(entry => [entry.id, entry]))
  const seen = new Set<string>([resource.id])
  const queue: string[] = (namedBy.get(resource.id) ?? []).map(entry => entry.from)

  while (queue.length > 0) {
    const id = queue.shift()!
    if (seen.has(id)) continue
    seen.add(id)
    const referrer = byId.get(id)
    if (referrer === undefined) continue

    // The referrer's own placement, if it has one that is not this resource.
    const placed = parentOf.get(id)
    if (placed !== undefined && placed !== resource.id) return placed

    // Otherwise take any container the referrer names, skipping this resource:
    // an EIP inside a NAT gateway also names the VPC both of them are in, and
    // that VPC is the gateway's home.
    const candidate = allContainers(referrer).find(entry => entry.id !== resource.id)
    if (candidate !== undefined) return candidate.id

    queue.push(...(namedBy.get(id) ?? []).map(entry => entry.from))
  }
  return undefined
}

/**
 * Whether `container` already sits inside `resource`.
 *
 * Used to refuse a placement that would invert the nesting: a VPC named by an
 * EIP whose gateway the VPC also holds must not then be placed inside that
 * gateway. The walk follows the placement chain upwards, and stops at a cycle
 * rather than looping.
 *
 * @param resource - the resource that would be the new container.
 * @param container - the box that would be placed inside it.
 * @param parentOf - the placement resolved so far.
 * @returns whether `container` is already below `resource`.
 */
function holdsTransitively(
  resource: string,
  container: string,
  parentOf: ReadonlyMap<string, string>,
): boolean {
  const seen = new Set<string>([container])
  let cursor: string | undefined = parentOf.get(container)
  while (cursor !== undefined) {
    if (cursor === resource) return true
    if (seen.has(cursor)) return false
    seen.add(cursor)
    cursor = parentOf.get(cursor)
  }
  return false
}

/**
 * Read which security groups guard each resource.
 *
 * @param resources - the account's resources.
 * @returns resource id → the group NAMES, sorted so two runs agree.
 */
export function guards(
  resources: readonly AccountResource[],
): Map<string, string[]> {
  const byId = new Map(resources.map(resource => [resource.id, resource]))
  const found = new Map<string, string[]>()

  for (const resource of resources) {
    for (const [attribute, value] of flattenProperties(resource.properties ?? {})) {
      if (!isGuardAttribute(attribute)) continue
      const target = idOf(value)
      if (target === undefined || target === resource.id) continue
      const group = byId.get(target)
      if (group === undefined) continue
      const names = found.get(resource.id) ?? []
      if (!names.includes(group.name ?? group.id)) names.push(group.name ?? group.id)
      found.set(resource.id, names)
    }
  }

  for (const names of found.values()) names.sort()
  return found
}

/**
 * The resources that use each security group.
 *
 * ## Why this is worth showing
 *
 * A group's rules say what it admits; its users say whether it matters. On a
 * live account 13 groups exist and only 6 are used by anything — and one of
 * those is used by three resources. A reader who has to open each group to find
 * out whether it is live cannot tell a housekeeping leftover from the group
 * guarding the database.
 *
 * @param resources - the account's resources.
 * @returns group id → the ids of the resources that name it.
 */
export function groupUsers(
  resources: readonly AccountResource[],
): Map<string, string[]> {
  const users = new Map<string, string[]>()
  for (const resource of resources) {
    for (const [attribute, value] of flattenProperties(resource.properties ?? {})) {
      if (!isGuardAttribute(attribute)) continue
      const target = idOf(value)
      if (target === undefined || target === resource.id) continue
      const groupId = target
      if (!resources.some(entry => entry.id === groupId)) continue
      const listed = users.get(groupId) ?? []
      if (!listed.includes(resource.id)) listed.push(resource.id)
      users.set(groupId, listed)
    }
  }

  return users
}

/**
 * Read the policy edges between security groups.
 *
 * ## What makes this an edge
 *
 * A rule on group A whose `remote_group_id` is group B says: traffic from
 * anything carrying B may reach anything carrying A, on this port. That is a
 * statement about reachability between two groups, with a direction and a port
 * — the only relationship in the account that has all three.
 *
 * Two rules that say the same thing (a group's rules are often duplicated by
 * the provider) are collapsed: a reader comparing the picture to the console
 * should not have to work out which arrow is which duplicate.
 *
 * @param resources - the account's resources.
 * @returns the policy edges, sorted for a stable picture.
 */
export function policies(
  resources: readonly AccountResource[],
): PolicyEdge[] {
  const groupNames = new Map(
    resources
      .filter(resource => resource.type === 'securityGroups')
      .map(resource => [resource.id, resource.name ?? resource.id]),
  )

  const edges: PolicyEdge[] = []
  const seen = new Set<string>()

  for (const resource of resources) {
    if (resource.type !== 'securityGroups') continue
    const rules = resource.properties?.['security_group_rules']
    if (!Array.isArray(rules)) continue

    for (const rule of rules) {
      if (rule === null || typeof rule !== 'object') continue
      const fields = rule as Record<string, unknown>
      const remote = idOf(fields['remote_group_id'])
      // A rule pointing at its own group is the default "members may talk to
      // each other" and carries no information between two groups.
      if (remote === undefined || remote === resource.id) continue
      if (!groupNames.has(remote)) continue

      const direction = typeof fields['direction'] === 'string' ? fields['direction'] : 'ingress'
      const protocol = typeof fields['protocol'] === 'string' && fields['protocol'] !== ''
        ? fields['protocol']
        : 'any'
      const low = fields['port_range_min']
      const high = fields['port_range_max']
      const ports = typeof low === 'number' || typeof low === 'string'
        ? `${String(low)}${String(low) === String(high) ? '' : `-${String(high)}`}`
        : undefined

      const key = `${remote}\u0000${resource.id}\u0000${direction}\u0000${protocol}\u0000${ports ?? ''}`
      if (seen.has(key)) continue
      seen.add(key)

      edges.push({ from: remote, to: resource.id, direction, protocol, ports })
    }
  }

  edges.sort((a, b) => (
    (groupNames.get(a.from) ?? '').localeCompare(groupNames.get(b.from) ?? '')
    || (groupNames.get(a.to) ?? '').localeCompare(groupNames.get(b.to) ?? '')
  ))
  return edges
}

/**
 * One rule worth showing on a security group's box.
 *
 * ## Why a rule is summarised rather than listed
 *
 * A group's rule list is mostly repetition the cloud adds for every group
 * alike: two self-referencing ingress rules (members may talk to each other)
 * and two egress rules admitting everything. Measured on a live account, 13
 * groups carry 65 rules, and only a handful say anything a reader did not
 * already know. Listing them all makes the picture three times taller for
 * information that is the same in every group.
 *
 * So only a rule that ADMITS SOMETHING SPECIFIC survives: a port range, a
 * source group, or a narrowed address range. What is dropped is reported as a
 * count, not silently — a reader who wants the full list gets it, and a reader
 * scanning the picture gets the rules that distinguish one group from another.
 */
export interface RuleSummary {
  /** `ingress` or `egress`. */
  readonly direction: string
  /** The protocol, or `any`. */
  readonly protocol: string
  /** The port range, or `all` for every port. */
  readonly ports: string
  /** What it admits from: a group name, a CIDR, or `self`. */
  readonly source: string
}

/**
 * Whether a rule says anything a reader would not assume.
 *
 * Three shapes are assumed and therefore dropped:
 *
 *   - a rule admitting the group's own members (`remote_group_id` = itself),
 *     which is the cloud's default for any group;
 *   - an egress rule admitting everything, which nearly every group has;
 *   - an exact duplicate of a rule already kept.
 *
 * @param rule - the provider's rule object.
 * @param groupId - the id of the group the rule belongs to.
 * @param nameOf - resolves a group id to its name.
 * @returns the summary, or `undefined` when the rule says nothing new.
 */
export function summarizeRule(
  rule: Record<string, unknown>,
  groupId: string,
  nameOf: (id: string) => string | undefined,
): RuleSummary | undefined {
  const direction = typeof rule['direction'] === 'string' ? rule['direction'] : 'ingress'
  const protocol = typeof rule['protocol'] === 'string' && rule['protocol'] !== ''
    ? rule['protocol']
    : 'any'
  const low = rule['port_range_min']
  const high = rule['port_range_max']
  const ports = typeof low === 'number' || typeof low === 'string'
    ? (String(low) === String(high) ? String(low) : `${String(low)}-${String(high)}`)
    : 'all'

  const remoteGroup = idOf(rule['remote_group_id'])
  const remoteCidr = typeof rule['remote_ip_prefix'] === 'string' && rule['remote_ip_prefix'] !== ''
    ? rule['remote_ip_prefix']
    : undefined

  // A group admitting itself is the default "members may talk to each other",
  // which every group has and no reader learns anything from.
  if (remoteGroup === groupId) return undefined

  const source = remoteGroup !== undefined
    ? (nameOf(remoteGroup) ?? remoteGroup)
    : remoteCidr ?? 'self'

  // An egress rule admitting everything, to anywhere. Nearly every group has
  // one and it is the cloud's default, so it distinguishes nothing — whether it
  // names `self`, a CIDR or a group.
  if (direction === 'egress' && ports === 'all' && protocol === 'any') {
    return undefined
  }

  return { direction, protocol, ports, source }
}

/**
 * The rules worth showing for one security group, split by direction.
 *
 * @param resources - the account's resources.
 * @returns group id → its ingress and egress summaries, each de-duplicated.
 */
export function ruleSummaries(
  resources: readonly AccountResource[],
): Map<string, { readonly ingress: readonly RuleSummary[], readonly egress: readonly RuleSummary[] }> {
  const nameOf = (id: string): string | undefined => (
    resources.find(resource => resource.id === id)?.name
  )

  const found = new Map<string, { ingress: RuleSummary[], egress: RuleSummary[] }>()
  for (const resource of resources) {
    if (resource.type !== 'securityGroups') continue
    const rules = resource.properties?.['security_group_rules']
    if (!Array.isArray(rules)) continue

    const bucket = { ingress: [] as RuleSummary[], egress: [] as RuleSummary[] }
    const seen = new Set<string>()
    for (const rule of rules) {
      if (rule === null || typeof rule !== 'object') continue
      const summary = summarizeRule(rule as Record<string, unknown>, resource.id, nameOf)
      if (summary === undefined) continue
      const key = `${summary.direction}\u0000${summary.protocol}\u0000${summary.ports}\u0000${summary.source}`
      if (seen.has(key)) continue
      seen.add(key)
      if (summary.direction === 'egress') bucket.egress.push(summary)
      else bucket.ingress.push(summary)
    }
    if (bucket.ingress.length > 0 || bucket.egress.length > 0) found.set(resource.id, bucket)
  }
  return found
}

/**
 * Read all three layers at once.
 *
 * @param resources - the account's resources.
 * @returns the resolved view.
 */
export function accountView(resources: readonly AccountResource[]): AccountView {
  const policyEdges = policies(resources)
  const policyGroups = new Set<string>()
  for (const edge of policyEdges) {
    policyGroups.add(edge.from)
    policyGroups.add(edge.to)
  }
  return {
    parentOf: containment(resources),
    guardsOf: guards(resources),
    policies: policyEdges,
    policyGroups,
  }
}