/**
 * The topology of an account that already exists, derived from what the
 * inventory reports.
 *
 * ## What this module knows, and why it is not a table of services
 *
 * The inventory returns resources as `{provider, type, id, name, properties}`.
 * Two different questions are answered from `properties`, and they are not the
 * same kind of question:
 *
 *   - **Association.** When one resource's property holds another resource's
 *     id, the two are related. That rule needs no vocabulary at all: an id is
 *     an id, whatever the service. Associations are drawn as edges.
 *   - **Location.** Which resource a box is drawn INSIDE is a fact about the
 *     network picture, not about the service that reported it. A network
 *     picture is made of networks and their subdivisions — that is what the
 *     domain is, in every cloud — so the location vocabulary is those nouns and
 *     nothing else: `vpc`, `subnet`.
 *
 * That vocabulary is two words. It is not a per-service table that grows with
 * every service, and it does not name a single service: a service this
 * deployment has never seen gets placed correctly the first time it appears, as
 * long as it says where it lives, because saying where it lives is what makes
 * it placeable.
 *
 * ## Why containment is not derived from the graph
 *
 * Reference counts cannot answer "what contains what". A rule built on them —
 * a container is a type that receives references and makes none back — fails
 * three ways, each of them checkable against a live account:
 *
 *   1. **It cannot nest three levels.** A server names both its subnet and its
 *      VPC; the subnet names the VPC. Each of those is a reference into a
 *      container, the deeper placement is never considered, and the server ends
 *      up inside the VPC with its subnet beside it — the one arrangement that is
 *      wrong.
 *   2. **It makes a security group a container.** A security group receives
 *      references and makes none back, which satisfies the rule exactly. A
 *      listener that names only a security group lands inside its box.
 *   3. **It depends on a complete graph, and the inventory is not complete.**
 *      RMS does not report subnets at all, so the counts a rule needs are
 *      missing the very edges that would say "this is a subnet of that VPC".
 *
 * Containment therefore comes from the attribute's own name, which is the
 * provider stating what the relationship is. `vpcId` says "this lives in that
 * VPC"; `securityGroupId` says "this is admitted by that group" — both are
 * references, only one is a location.
 *
 * ## What it deliberately does not do
 *
 * It does not decide that a resource is unimportant. Every resource the
 * inventory returned becomes a node. A diagram that hides things needs a
 * reason to hide them, and a rule for "important" is a table by another name.
 *
 * @module @huaweidevtools/aishell-dsh-deploy/existing-topology
 */

/** One resource as the inventory reports it. */
export interface InventoryResource {
  readonly id: string
  /** The service, e.g. `vpc`, `ecs`, `rds`. */
  readonly provider: string
  /** The service's own type name, e.g. `vpcs`, `cloudservers`, `securityGroups`. */
  readonly type: string
  readonly name?: string
  readonly region?: string
  readonly properties?: Readonly<Record<string, unknown>>
}

/** One node in the derived picture. */
export interface InventoryNode {
  /** Stable identity: the cloud resource id. */
  readonly id: string
  readonly provider: string
  readonly type: string
  readonly label: string
  /** Facts worth showing on the box, already chosen. */
  readonly facts: readonly { readonly key: string, readonly value: string }[]
  /** The container this node sits in, when one was found. */
  readonly parent: string | undefined
  /** Every container above this node, nearest first. */
  readonly ancestors: readonly string[]
  readonly children: readonly InventoryNode[]
}

/** One relationship between two resources. */
export interface InventoryEdge {
  readonly from: string
  readonly to: string
  /** The attribute that establishes it, e.g. `vnic.vpcId`. */
  readonly attribute: string
  /**
   * Whether this attribute names a container rather than a peer.
   *
   * Both are drawn; the distinction decides nesting versus an arrow, and is
   * carried rather than acted on here so a reader can see why a resource was
   * placed where it was.
   */
  readonly contains: boolean
}

/** The whole derived picture. */
export interface InventoryTopology {
  readonly roots: readonly InventoryNode[]
  readonly nodes: readonly InventoryNode[]
  readonly edges: readonly InventoryEdge[]
  /** Resources that appeared in more than one provider/type bucket. */
  readonly duplicates: readonly string[]
}

/** Facts worth showing on a box, by the attribute name that holds them. */
const LABEL_ATTRIBUTES = [
  'name',
  'cidr',
  'publicIpAddress',
  'ipAddress',
  'vip_address',
  'flavor',
  'flavorCode',
  'spec',
  'nodeFlavor',
  'clusterFlavor',
  'size',
  'engineName',
  'engineVersion',
  'status',
  'instanceStatus',
  'clusterStatus',
  'provisioning_status',
  'availability_zone',
  'az',
] as const

/**
 * Every scalar the properties contain, keyed by its dotted path.
 *
 * Nested objects and arrays are flattened because the inventory nests ids
 * arbitrarily deep (`vnic.vpcId`, `bandwidth.id`,
 * `security_group_rules[].remote_group_id`), and a rule that only looked at the
 * top level would miss most of the relationships.
 *
 * A JSON-encoded value is also opened, because the inventory sometimes ships one
 * as a string. RDS is the case that was measured: it reports `vpcId` as
 * `"[\"73e76381-…\"]"` and `networkId` as its subnet — a real reference, present
 * and correct, that a plain string comparison never matches. Left closed, the
 * RDS instance floats at the root of the picture with its VPC in plain sight in
 * its own properties.
 *
 * @param value - any property value.
 * @returns path → scalar, for every leaf.
 */
export function flattenProperties(
  value: unknown,
): Map<string, string> {
  const found = new Map<string, string>()
  const walk = (node: unknown, path: string): void => {
    if (typeof node === 'string') {
      if (isJsonEncoded(node)) {
        try {
          walk(JSON.parse(node) as unknown, path)
          return
        } catch {
          // Not actually JSON — keep it as the string it is.
        }
      }
      found.set(path, node)
      return
    }
    if (typeof node === 'number' || typeof node === 'boolean') {
      found.set(path, String(node))
      return
    }
    if (Array.isArray(node)) {
      // Arrays collapse to one path: a rule's `remote_group_id` is the same
      // relationship whether the rule block repeats or not.
      for (const entry of node) walk(entry, path)
      return
    }
    if (node !== null && typeof node === 'object') {
      for (const [key, inner] of Object.entries(node as Record<string, unknown>)) {
        walk(inner, path === '' ? key : `${path}.${key}`)
      }
    }
  }
  walk(value, '')
  return found
}

/**
 * Whether a string holds a JSON array or object worth opening.
 *
 * The check is deliberately narrow: an id is a plain string and must stay one,
 * so only a leading `{` or `[` that parses is opened. A quoted string inside a
 * range or a name that happens to start with a bracket would fail to parse and
 * be kept verbatim.
 *
 * @param text - the property value.
 * @returns whether it is worth attempting to parse.
 */
function isJsonEncoded(text: string): boolean {
  const first = text.trimStart()[0]
  return first === '[' || first === '{'
}

/** The kinds a box can be drawn inside, and how specific each is. */
const LOCATION_KINDS: readonly { readonly nouns: readonly string[], readonly rank: number }[] = [
  // A VPC is the outermost thing the picture draws.
  { nouns: ['vpc'], rank: 1 },
  // A subnet is inside a VPC, so naming one is the more specific answer.
  //
  // `network` is the same thing under another name: RDS reports its subnet as
  // `networkId`. It is listed here because the alternative is a second
  // containment rule for one service, and because the word was checked against
  // every resource in a live 49-resource account — the only places it appears
  // as an id are that field; elsewhere it is `networkType` ("5_bgp") or a
  // cluster's boolean, neither of which is a reference at all.
  { nouns: ['subnet', 'network'], rank: 2 },
]

/**
 * How specific a location an attribute names, 0 when it names none.
 *
 * The tail of the path is what counts: `vnic.vpcId` and `metadata.vpcId` both
 * end in a noun describing the container. Everything before the last dot is the
 * service's own nesting and says nothing about which container this is.
 *
 * The `id`/`uid`/`uuid` suffix is stripped rather than required to be present,
 * because the provider writes all three (`subnet_id`, `subnetId`,
 * `virsubnet_id`) and a rule that demanded one spelling would miss the others.
 * A plural suffix is stripped too: `elb_virsubnet_ids` holds several subnets,
 * and whether the attribute holds one id or a list does not change what it
 * names. Suffix matching, not equality, is what makes `virsubnet` and
 * `subnetwork` land on the same noun.
 *
 * @param attribute - a dotted property path.
 * @returns the rank of the location it names, or 0 for a plain association.
 */
export function locationRank(attribute: string): number {
  const tail = attribute.split('.').pop() ?? attribute
  const noun = tail
    .replace(/(_?ids|_?id|_?uids|_?uid|uuid)$/i, '')
    .replace(/[^a-z]/gi, '')
    .toLowerCase()
  for (const { nouns, rank } of LOCATION_KINDS) {
    for (const word of nouns) {
      if (noun.endsWith(word)) return rank
    }
  }
  return 0
}

/**
 * Derive the picture from what the inventory reported.
 *
 * @param resources - every resource the inventory returned.
 * @returns nodes, edges, and the nesting derived from both.
 */
export function deriveInventoryTopology(
  resources: readonly InventoryResource[],
): InventoryTopology {
  // The inventory paginates per service, so the same resource can arrive twice
  // when a query overlapping two services is made. Its id is the identity;
  // the first description wins.
  const byId = new Map<string, InventoryResource>()
  const duplicates: string[] = []
  for (const resource of resources) {
    if (byId.has(resource.id)) {
      if (!duplicates.includes(resource.id)) duplicates.push(resource.id)
      continue
    }
    byId.set(resource.id, resource)
  }

  const flat = new Map<string, Map<string, string>>()
  for (const [id, resource] of byId) flat.set(id, flattenProperties(resource.properties ?? {}))

  // A property whose value is another resource's id is a relationship. Whether
  // that relationship is also a LOCATION is a different question, answered by
  // the attribute's own noun — see `locationRank`. Both facts are carried: an
  // arrow is drawn for every association, and only a location becomes nesting.
  const raw: { from: string, to: string, attribute: string, location: number }[] = []
  const seen = new Set<string>()
  for (const [id, properties] of flat) {
    for (const [attribute, value] of properties) {
      if (value === id) continue
      if (!byId.has(value)) continue
      const key = `${id}\u0000${value}`
      if (seen.has(key)) continue
      seen.add(key)
      raw.push({ from: id, to: value, attribute, location: locationRank(attribute) })
    }
  }

  // Every association is an edge. `contains` reports whether its own attribute
  // names a location — the nesting itself is decided below, because a node that
  // names two locations has two edges and only one of them is where it lives.
  const edges: InventoryEdge[] = raw.map(entry => ({
    from: entry.from,
    to: entry.to,
    attribute: entry.attribute,
    contains: entry.location > 0,
  }))

  // A node's container is the most specific location it names.
  //
  // A server names both its subnet and its VPC: both are locations, and the
  // subnet is the better answer because it is inside the VPC. Picking one edge
  // at a time — "the first location wins" — would depend on the order the
  // provider happened to write its properties, which is not a reason.
  const parentOf = new Map<string, string>()
  const parentRank = new Map<string, number>()
  for (const entry of raw) {
    if (entry.location === 0) continue
    if (entry.location > (parentRank.get(entry.from) ?? 0)) {
      parentOf.set(entry.from, entry.to)
      parentRank.set(entry.from, entry.location)
    }
  }

  // A container cannot sit inside its own descendant; dropping the placement
  // keeps the node at the root, which a reader can see and fix.
  //
  // The copy is required, not decorative: this loop deletes from `parentOf`
  // while walking it, and a live iterator skips the entry that follows a
  // deletion — which would leave half the cycles unbroken.
  // eslint-disable-next-line unicorn/no-useless-spread
  for (const [child, parent] of [...parentOf]) {
    const seenChain = new Set<string>([child])
    let cursor: string | undefined = parent
    while (cursor !== undefined) {
      if (seenChain.has(cursor)) { parentOf.delete(child); break }
      seenChain.add(cursor)
      cursor = parentOf.get(cursor)
    }
  }

  const childrenOf = new Map<string, string[]>()
  for (const [child, parent] of parentOf) {
    const list = childrenOf.get(parent) ?? []
    list.push(child)
    childrenOf.set(parent, list)
  }

  const factsOf = (resource: InventoryResource): { key: string, value: string }[] => {
    const properties = flat.get(resource.id) ?? new Map<string, string>()
    const label = resource.name ?? ''
    const facts: { key: string, value: string }[] = []
    for (const key of LABEL_ATTRIBUTES) {
      const value = properties.get(key)
      // The box already leads with the name; repeating it as a fact says the
      // same thing twice on one line. An EIP whose `name` is its own address
      // made that visible.
      if (value === undefined || value === '' || value === label) continue
      // One fact per attribute: an object echoed several paths (a status under
      // both `status` and `instanceStatus`) would otherwise fill the line.
      if (facts.some(fact => fact.value === value)) continue
      facts.push({ key, value })
    }
    return facts
  }

  const ancestorsOf = (id: string): string[] => {
    const chain: string[] = []
    const seenChain = new Set<string>([id])
    let cursor = parentOf.get(id)
    while (cursor !== undefined && !seenChain.has(cursor)) {
      seenChain.add(cursor)
      chain.push(cursor)
      cursor = parentOf.get(cursor)
    }
    return chain
  }

  const build = (id: string): InventoryNode => {
    const resource = byId.get(id)!
    return {
      id,
      provider: resource.provider,
      type: resource.type,
      label: resource.name !== undefined && resource.name !== ''
        ? resource.name
        : `${resource.provider}/${resource.type} ${id.slice(0, 8)}`,
      facts: factsOf(resource),
      parent: parentOf.get(id),
      ancestors: ancestorsOf(id),
      children: (childrenOf.get(id) ?? []).map(build),
    }
  }

  // Deterministic order: container-first by depth, then by label, so two runs
  // of the same inventory draw the same picture.
  const rootIds = [...byId.keys()].filter(id => !parentOf.has(id))
  const depth = (id: string): number => ancestorsOf(id).length
  rootIds.sort((a, b) => {
    const da = depth(a), db = depth(b)
    if (da !== db) return db - da
    return (byId.get(a)!.name ?? a).localeCompare(byId.get(b)!.name ?? b)
  })

  return {
    roots: rootIds.map(build),
    nodes: [...byId.keys()].map(build),
    edges,
    duplicates,
  }
}