/**
 * The network topology, derived from the `.tf` files a deployment contains.
 *
 * ## What this module is
 *
 * A pure transform: resource blocks in, a normalized topology out. No
 * filesystem, no terraform binary, no rendering — those live in the callers.
 * Keeping the derivation pure is what makes the interesting part testable: the
 * containment rule, the reference resolution and the display facts all run
 * against a string.
 *
 * ## Why the `.tf` is the source of truth
 *
 * A network design and the resources that implement it are the same
 * configuration. Holding a second, hand-written description of the network
 * beside the `.tf` means two statements of one fact, and the day they disagree
 * there is no way to tell which one terraform will act on. Deriving the
 * topology from the configuration removes the second statement entirely: every
 * node in the diagram is a resource block terraform will create, and the
 * picture cannot drift from what runs.
 *
 * What follows from that choice:
 *
 *   - The model edits `.tf` and nothing else. There is no synchronisation step.
 *   - `terraform validate` becomes the schema. Provider attribute names,
 *     required-ness and value formats are checked by the provider itself, so
 *     this module never encodes any of them.
 *   - What the provider does NOT check — overlapping CIDRs, a gateway outside
 *     its subnet, a rule open to the world — is reported by `network-checks` as
 *     a FINDING rather than a validation error. Those are properties of the
 *     assembled network, not of any single block, and `terraform validate`
 *     accepts them.
 *
 * ## Containment is read from the configuration, never guessed
 *
 * A subnet lives inside the VPC its `vpc_id` names. That reference is the only
 * evidence of containment available before terraform runs, so it is what
 * decides the nesting. A node whose containment reference is missing or points
 * at an unknown resource lands at the root — visibly unparented, which a reader
 * can see and fix, rather than silently nested in the wrong box.
 *
 * @module @huaweidevtools/aishell-dsh-deploy/topology
 */

import { firstReference, literalOf, referencesOf, stringsIn } from './hcl.ts'
import type { ResourceBlock } from './hcl.ts'
import { findProblems } from './network-checks.ts'
import { kindOfExisting, kindOfResource } from './existing.ts'
import type { ExistingResource } from './existing.ts'

/**
 * What a node in the topology represents.
 *
 * These are the kinds a network design is written in — nothing else appears in
 * the picture. A resource outside this list is reported by name (see
 * {@link Topology.omitted}) rather than drawn, because a diagram is read by
 * comparing boxes and a box that represents nothing the reader is comparing
 * against is noise exactly where the signal has to fit.
 */
export type NodeKind =
  | 'vpc'
  | 'subnet'
  | 'security-group'
  | 'security-group-rule'
  | 'gateway'
  | 'load-balancer'
  /** A compute instance: belongs to the subnet its `network` block names. */
  | 'compute'
  /** A managed database (RDS, DCS, GaussDB): belongs to its `subnet_id`. */
  | 'database'

/**
 * Display order for node kinds.
 *
 * Siblings are drawn in this order so a diagram reads top-down as the network
 * is actually built: the VPC, then the subnets cut from it, then what admits
 * traffic into them. Without it the order is whatever the HCL parser happened
 * to return, which is not the file's order and not any order a reader can
 * predict. Computes and databases come last, because they are what the network
 * is FOR and they sit at the deepest level.
 */
const KIND_ORDER: readonly NodeKind[] = [
  'vpc',
  'subnet',
  'security-group',
  'security-group-rule',
  'load-balancer',
  'gateway',
  'compute',
  'database',
]

/** Where a kind sits in {@link KIND_ORDER}. */
function kindRank(kind: NodeKind): number {
  const index = KIND_ORDER.indexOf(kind)
  return index === -1 ? KIND_ORDER.length : index
}

/** One node in the derived picture. */
export interface TopologyNode {
  /** Stable identity: the terraform address (`huaweicloud_vpc_subnet.web`). */
  readonly address: string
  readonly type: string
  readonly name: string
  readonly kind: NodeKind
  /**
   * Whether this resource already exists in the account, rather than being
   * created by this deployment.
   *
   * The distinction is the one a reviewer checks first ("am I about to
   * duplicate what we have?"), so it is a property of the node rather than
   * something a renderer infers from its address.
   */
  readonly existing: boolean
  /** The address of the node this one belongs inside, or `undefined` at the root. */
  readonly parent: string | undefined
  /**
   * Every container above this node, nearest first (`[parent, grandparent, …]`).
   *
   * A compute instance is placed in a subnet, but a reader asking "where does
   * this live" means the VPC too. The chain is precomputed so a renderer never
   * has to walk parents itself.
   */
  readonly ancestors: readonly string[]
  /** Attributes worth showing on the box, already chosen for display. */
  readonly facts: readonly TopologyFact[]
  /** The node's children, in configuration order. */
  readonly children: readonly TopologyNode[]
}

/** One attribute shown on a node's box. */
export interface TopologyFact {
  readonly key: string
  readonly value: string
}

/**
 * How two VPCs are joined.
 *
 * A connection is a RELATIONSHIP, not a device: a peering, an endpoint or a
 * route has no place of its own, and drawing it as a box would present it as
 * something the network contains. What it says is "these two are reachable from
 * each other, this way" — so it becomes a labelled edge between the two VPCs,
 * which is how a reader asks the question.
 */
export interface TopologyConnection {
  /** The terraform address of the resource that establishes it. */
  readonly address: string
  readonly type: string
  /** `peering` | `endpoint` | `route`, for the label and the colour. */
  readonly kind: ConnectionKind
  /** The VPC addresses it joins. Either may be absent when unresolved. */
  readonly from: string | undefined
  readonly to: string | undefined
}

/**
 * The ways this provider joins two networks.
 *
 * Each is a resource whose placement argument is `vpc_id`, and whose other
 * side is either an explicit peer or a service reached through an endpoint:
 *
 *   - `huaweicloud_vpc_peering_connection` — `vpc_id` ↔ `peer_vpc_id`.
 *   - `huaweicloud_vpcep_endpoint` — `vpc_id` ↔ the endpoint service's VPC. The
 *     service is usually another account's, so the far side is often not in
 *     this configuration at all; the edge is then drawn to the endpoint
 *     SERVICE, which is what the EC is reachable at.
 *   - `huaweicloud_vpc_route` — `vpc_id` → wherever the next hop goes. Exactly
 *     one side is in this deployment in most cases.
 *
 * A route is the weakest of the three as a "connection": it points at a next
 * hop rather than at a peer. It is included because a reader tracing how a
 * subnet reaches the outside world needs to see it, and excluded from the
 * object is nothing.
 */
export type ConnectionKind = 'peering' | 'endpoint' | 'route'

/** How serious a finding is. */
export type FindingSeverity = 'error' | 'warning'

/**
 * A design problem the provider's own validation does not catch.
 *
 * Reported, not enforced: `terraform validate` passing does not mean the
 * network is sensible, and a deployment that silently accepts overlapping
 * subnets is one whose first `apply` produces a broken VPC.
 */
export interface Finding {
  readonly severity: FindingSeverity
  /** One-line statement of the problem, naming the resources involved. */
  readonly summary: string
  /** Why it matters, and what to do about it. */
  readonly detail: string
  /** The resource addresses involved, so a reader can go straight to them. */
  readonly addresses: readonly string[]
}

/** The whole derived picture. */
export interface Topology {
  /** Root nodes in configuration order; children are nested inside. */
  readonly roots: readonly TopologyNode[]
  /** Every node, flattened, for lookups. */
  readonly nodes: readonly TopologyNode[]
  /** Design problems found while deriving. */
  readonly findings: readonly Finding[]
  /** Node kinds present, so a renderer can decide whether there is a picture. */
  readonly kinds: readonly NodeKind[]
  /**
   * How the VPCs in this design reach each other.
   *
   * Reported separately from the nodes because a connection is not a thing the
   * network contains — it is a relationship between two of them, and the
   * picture draws it as a labelled edge.
   */
  readonly connections: readonly TopologyConnection[]
  /**
   * Resources the configuration declares that the picture does not show.
   *
   * Reported rather than ignored, and counted rather than listed one by one:
   * a deployment legitimately declares alarm rules, backups, key pairs and
   * parameter templates alongside its network, and a reader needs to know the
   * diagram is not the whole file — without reading forty boxes to find out.
   */
  readonly omitted: readonly OmittedResource[]
}

/** One resource type left out of the picture, and how many of it there are. */
export interface OmittedResource {
  readonly type: string
  readonly count: number
}

/**
 * The node kind a configured resource type takes, when the picture has one.
 *
 * Deliberately the SAME table the existing-resource side reads
 * ({@link kindOfExisting}), because a resource is the same thing whether it is
 * being created or adopted: a `huaweicloud_rds_instance` in the `.tf` and one
 * reported by `list_existing_resources` must take one colour and one
 * containment rule. Two tables would let those drift, and the drift would show
 * up as a resource drawn differently depending on where it came from.
 *
 * `undefined` means the resource is not part of the topology. It is NOT drawn
 * at the root: an unclassified box would read as "this belongs nowhere in
 * particular", which is a claim about placement that nothing checked.
 *
 * @param type - the terraform resource type.
 * @returns the node kind, or `undefined` when the picture is not about it.
 */
function kindOfType(type: string): NodeKind | undefined {
  return kindOfExisting(type)
}

/**
 * The connection a resource establishes, when it establishes one.
 *
 * These resources are NOT boxes. A peering connection has no location of its
 * own; drawing it as a node would put a box in the network that contains
 * nothing, and would leave the two VPCs it joins looking unrelated. So it is
 * recognised here and becomes an edge instead.
 *
 * Each specification says which attribute names the second network:
 *
 *   - a peering names its peer in `peer_vpc_id`;
 *   - an endpoint names the service it reaches in `service_id` — usually
 *     another account's endpoint service, which is the thing the endpoint makes
 *     the VPC able to reach;
 *   - a route names its next hop in `next_hop`, or falls through to any other
 *     reference it makes.
 *
 * The first network is always `vpc_id`, which every one of them carries.
 */
const CONNECTION_SPECS: Readonly<Partial<Record<string, {
  readonly kind: ConnectionKind
  /** Attributes naming the far side, in preference order. */
  readonly farSide: readonly string[]
}>>> = {
  huaweicloud_vpc_peering_connection: { kind: 'peering', farSide: ['peer_vpc_id'] },
  huaweicloud_vpcep_endpoint: { kind: 'endpoint', farSide: ['service_id'] },
  huaweicloud_vpcep_service: { kind: 'endpoint', farSide: [] },
  huaweicloud_vpc_route: { kind: 'route', farSide: ['next_hop', 'route_table_id'] },
}

/**
 * Every connection the configuration establishes.
 *
 * Resolved against the node addresses the topology derived, so a connection
 * whose far side is not in this deployment (a peer in another account, an
 * endpoint service published elsewhere) yields an edge with a missing end and
 * is skipped by the renderer — reported rather than drawn to an invented box.
 *
 * ## Why an endpoint needs the hop through its service
 *
 * `huaweicloud_vpcep_endpoint.service_id` names an endpoint SERVICE, which is
 * not a box in the picture — it is an entry point. What the endpoint actually
 * buys the VPC is reachability to whatever that service publishes, and when the
 * service is in this configuration its `vpc_id` IS the far network. So the hop
 * is followed: endpoint → service → its VPC.
 *
 * When the service belongs to another account the hop finds nothing, and no
 * edge is drawn. That is the honest answer — the far VPC is not in this
 * deployment, and inventing a box for it would place a network this design does
 * not own.
 *
 * @param blocks - every resource block.
 * @param byAddress - the nodes, by address.
 * @returns one entry per connection resource.
 */
function connectionsIn(
  blocks: readonly ResourceBlock[],
  byAddress: ReadonlyMap<string, MutableNode>,
): TopologyConnection[] {
  // `vpc_id` of every endpoint service, so an endpoint can resolve the service
  // it names to the VPC that service belongs to.
  const serviceVpc = new Map<string, string>()
  for (const block of blocks) {
    if (block.type !== 'huaweicloud_vpcep_service') continue
    const vpc = resolveVpc(block.body.vpc_id, byAddress)
    if (vpc !== undefined) serviceVpc.set(`${block.type}.${block.name}`, vpc)
  }

  const connections: TopologyConnection[] = []
  for (const block of blocks) {
    const spec = CONNECTION_SPECS[block.type]
    if (spec === undefined) continue
    const address = `${block.type}.${block.name}`

    const from = resolveVpc(block.body.vpc_id, byAddress)
    // An endpoint service has no far side of its own: it IS the far side that an
    // endpoint elsewhere reaches. Its edge comes from the endpoint, below.
    const to = spec.farSide.length === 0
      ? undefined
      : spec.farSide
        .map(attribute => resolveFarSide(block.body[attribute], byAddress, serviceVpc))
        .find(target => target !== undefined)

    connections.push({
      address,
      type: block.type,
      kind: spec.kind,
      from,
      to,
    })
  }
  return connections
}

/**
 * The network an attribute leads to, following an endpoint service when it names one.
 *
 * @param value - the attribute's value as written.
 * @param byAddress - the nodes, by address.
 * @param serviceVpc - endpoint service address → the VPC it belongs to.
 * @returns the far VPC's address, or `undefined` when it is not in this design.
 */
function resolveFarSide(
  value: unknown,
  byAddress: ReadonlyMap<string, MutableNode>,
  serviceVpc: ReadonlyMap<string, string>,
): string | undefined {
  for (const text of stringsIn(value)) {
    for (const address of addressesOf(text)) {
      // Directly a box.
      if (byAddress.has(address)) return address
      // An endpoint service: the VPC it publishes from is the far network.
      const vpc = serviceVpc.get(address)
      if (vpc !== undefined) return vpc
    }
  }
  return undefined
}

/**
 * The VPC address an attribute names, when it names one.
 *
 * @param value - the attribute's value as written.
 * @param byAddress - the nodes, by address.
 * @returns the VPC's address, or `undefined`.
 */
function resolveVpc(
  value: unknown,
  byAddress: ReadonlyMap<string, MutableNode>,
): string | undefined {
  for (const text of stringsIn(value)) {
    for (const address of addressesOf(text)) {
      if (byAddress.get(address)?.kind === 'vpc') return address
    }
  }
  return undefined
}


/**
 * How a node's kind finds its containing subnet.
 *
 * Three shapes, because the provider spells placement three ways:
 *
 *   - `vpc_id` — a subnet or a security group names its VPC directly.
 *   - a block attribute — a compute instance's subnet is the `uuid` inside its
 *     `network` block, which may repeat.
 *   - `subnet_id` — a managed database names its subnet directly.
 *
 * A node whose container is a subnet can still be CONTAINED in one even when
 * its `vpc_id` is absent: the subnet already knows its VPC, so the nesting is
 * inherited rather than repeated.
 */
type ContainerRule =
  /** A top-level attribute naming the parent. */
  | { readonly attribute: string, readonly parentKind: NodeKind }
  /** A repeatable nested block whose member attribute names the parent. */
  | { readonly block: string, readonly attribute: string, readonly parentKind: NodeKind }

const PARENT_ATTRIBUTE: Readonly<Partial<Record<NodeKind, ContainerRule>>> = {
  subnet: { attribute: 'vpc_id', parentKind: 'vpc' },
  // A security group has no `vpc_id` attribute in this provider: it is an
  // account-level object and does not live in a VPC.
  // It is drawn at the root, which is where it actually is.
  'security-group-rule': { attribute: 'security_group_id', parentKind: 'security-group' },
  compute: { block: 'network', attribute: 'uuid', parentKind: 'subnet' },
  database: { attribute: 'subnet_id', parentKind: 'subnet' },
}

/** Attributes worth showing on a node's box, per kind. */
const DISPLAY_ATTRIBUTES: Readonly<Partial<Record<NodeKind, readonly string[]>>> = {
  // `name` is listed on every kind that has one, even though the box already
  // leads with it: the label reads the cloud name from these facts, and the
  // terraform label is only its fallback. Keeping it here means one place
  // decides what a box knows about a resource.
  vpc: ['name', 'cidr'],
  subnet: ['name', 'cidr', 'availability_zone', 'gateway_ip'],
  'security-group': ['name'],
  // Direction and ports are what a rule MEANS; without them the box is a name.
  // `remote_group_id` is listed so a rule that admits another GROUP shows that
  // relationship — the alternative (a bare port number) hides who may connect.
  'security-group-rule': ['direction', 'ports', 'remote_ip_prefix', 'remote_group_id'],
  gateway: ['name'],
  'load-balancer': ['name'],
  // The flavour is the spec, and the spec is what a price is quoted against —
  // without it the box says nothing a reader can act on.
  compute: ['name', 'flavor_id', 'image_id'],
  database: ['name', 'flavor', 'engine'],
}

/**
 * Derive the whole topology from resource blocks.
 *
 * @param blocks - every resource block across the deployment's `.tf` files.
 * @returns the nested picture, the flat node list, and the findings.
 */
export function deriveTopology(
  blocks: readonly ResourceBlock[],
  existing: readonly ExistingResource[] = [],
): Topology {
  const byAddress = new Map<string, MutableNode>()
  const order: MutableNode[] = []
  const omittedCounts = new Map<string, number>()

  for (const block of blocks) {
    const kind = kindOfType(block.type)
    if (kind === undefined) {
      // A connection is not omitted — it is drawn, as an edge. Counting it as
      // something the picture left out would report the opposite of the truth.
      if (CONNECTION_SPECS[block.type] === undefined) {
        omittedCounts.set(block.type, (omittedCounts.get(block.type) ?? 0) + 1)
      }
      continue
    }
    const node: MutableNode = {
      address: `${block.type}.${block.name}`,
      type: block.type,
      name: block.name,
      kind,
      existing: false,
      parent: undefined,
      ancestors: [],
      facts: displayFacts(block, kind),
      children: [],
    }
    byAddress.set(node.address, node)
    order.push(node)
  }

  // Existing resources join the same node list, keyed by their cloud ID. Their
  // address is that id, which cannot collide with a `type.name` address — and
  // an existing resource managed by nobody in this configuration has no
  // address of its own to take.
  //
  // An existing resource of an unclassified type is dropped on the same rule: a
  // caller that sent the account's whole inventory gets the network it
  // designed, not the alarm rules that happened to be in it.
  for (const resource of existing) {
    const kind = kindOfResource(resource)
    if (kind === undefined) {
      omittedCounts.set(resource.type, (omittedCounts.get(resource.type) ?? 0) + 1)
      continue
    }
    const node: MutableNode = {
      address: resource.id,
      type: resource.type,
      name: resource.name ?? resource.id,
      kind,
      existing: true,
      parent: undefined,
      ancestors: [],
      facts: existingFacts(resource),
      children: [],
    }
    byAddress.set(node.address, node)
    order.push(node)
  }

  // Containment runs as a second pass: a child can appear before its parent in
  // the configuration, and the parent has to exist before the edge is drawn.
  //
  // A child may name a container that is NOT in this configuration — the
  // normal case when a new subnet is cut from a VPC that already exists. That
  // module was given those resources separately, so the reference is also
  // matched against them: a `vpc_id = huaweicloud_vpc.prod.id` whose
  // `huaweicloud_vpc.prod` is not declared resolves to the existing resource
  // the caller designated as standing for it. Without this the subnet floats at
  // the root, which reads as "this creates a new VPC" — the opposite of the
  // truth.
  for (const block of blocks) {
    const node = byAddress.get(`${block.type}.${block.name}`)
    if (node === undefined) continue
    const rule = PARENT_ATTRIBUTE[node.kind]
    if (rule === undefined) continue
    const value = bodyForRule(block.body, rule)
    const target = matchReferenceTarget(value, byAddress, rule.parentKind)
      ?? matchExistingTarget(value, rule.parentKind, existing, byAddress)
    if (target !== undefined) node.parent = target
  }

  // Existing resources name their container by cloud ID, not by a terraform
  // reference: nothing in this configuration declares them, so there is no
  // `type.name` for a reference to resolve against. A parent id that names no
  // known node leaves the box at the root, the same rule as everywhere else.
  //
  // This has to run BEFORE the children are collected: setting `parent` after
  // that pass leaves the node out of its parent's `children`, so it is neither
  // a root nor anybody's child and disappears from the diagram entirely.
  for (const resource of existing) {
    const node = byAddress.get(resource.id)
    if (node === undefined || resource.parent === undefined) continue
    const parent = byAddress.get(resource.parent)
    if (parent !== undefined) node.parent = parent.address
  }

  for (const node of order) {
    if (node.parent === undefined) continue
    byAddress.get(node.parent)?.children.push(node)
  }

  // A node placed in a subnet is also inside that subnet's VPC — the nesting is
  // the reader's answer to "where does this live", so one level of it is not
  // enough. This runs after the direct pass so a chain resolves in one go,
  // and stops at a cycle rather than looping.
  for (const node of order) {
    let cursor = node.parent
    const seen = new Set<string>([node.address])
    while (cursor !== undefined && !seen.has(cursor)) {
      seen.add(cursor)
      const ancestor = byAddress.get(cursor)
      if (ancestor === undefined) break
      node.ancestors.push(cursor)
      cursor = ancestor.parent
    }
  }

  // Sort every level by kind. Children were pushed in configuration order,
  // which is the order the parser returned the files' blocks — stable, but not
  // an order a reader can predict from the picture.
  const sortByKind = (nodes: MutableNode[]): void => {
    nodes.sort((a, b) => kindRank(a.kind) - kindRank(b.kind))
    for (const node of nodes) sortByKind(node.children)
  }
  sortByKind(order)

  return {
    roots: order.filter(node => node.parent === undefined).map(freezeNode),
    nodes: order.map(freezeNode),
    findings: findProblems(blocks, byAddress, existing),
    kinds: [...new Set(order.map(node => node.kind))],
    // Resolved after the nodes exist: a connection names two VPCs by their
    // terraform addresses, and neither side is drawable until the topology has
    // decided which of them are in the picture.
    connections: connectionsIn(blocks, byAddress),
    // Sorted by count, then name: the largest omission is what a reader is most
    // likely to have expected to see.
    omitted: [...omittedCounts.entries()]
      .map(([type, count]) => ({ type, count }))
      .sort((a, b) => b.count - a.count || a.type.localeCompare(b.type)),
  }
}

/** A node under construction; `children`, `parent` and `ancestors` are filled by the second pass. */
interface MutableNode {
  address: string
  type: string
  name: string
  kind: NodeKind
  existing: boolean
  parent: string | undefined
  ancestors: string[]
  facts: TopologyFact[]
  children: MutableNode[]
}

/**
 * The facts worth showing on an existing resource's box.
 *
 * Only what the caller supplied. There is no configuration to read them from,
 * and inventing a value (filling a missing CIDR with the VPC's) would put a
 * fact on the picture that nothing checked.
 *
 * @param resource - one existing resource.
 * @returns the facts, in a fixed order so two diagrams read the same way.
 */
function existingFacts(resource: ExistingResource): TopologyFact[] {
  const facts: TopologyFact[] = []
  if (resource.cidr !== undefined) facts.push({ key: 'cidr', value: resource.cidr })
  if (resource.flavor !== undefined) facts.push({ key: 'flavor', value: resource.flavor })
  if (resource.region !== undefined) facts.push({ key: 'region', value: resource.region })
  return facts
}

/**
 * The existing resource a reference stands for, when the reference names a
 * resource this configuration does not declare.
 *
 * That is the normal case for a new subnet cut from a VPC that already exists:
 * the `.tf` says `vpc_id = huaweicloud_vpc.prod.id` and declares no
 * `huaweicloud_vpc.prod`, because that VPC is not this deployment's to create.
 *
 * The correspondence comes from the caller's `address` field, not from a name.
 * A cloud name (`prod-vpc`) and a terraform label (`prod`) are independent
 * choices; deriving one from the other would be a guess, and a subnet nested
 * into the wrong VPC looks correct while being wrong. An existing resource
 * without `address` is one nothing references, which is a legitimate thing to
 * draw.
 *
 * @param value - the attribute's value as written.
 * @param expectedKind - the kind the container must have.
 * @param existing - the resources the caller reported.
 * @param byAddress - every node, by address.
 * @returns the matching existing node's address, or `undefined`.
 */
function matchExistingTarget(
  value: unknown,
  expectedKind: NodeKind,
  existing: readonly ExistingResource[],
  byAddress: ReadonlyMap<string, MutableNode>,
): string | undefined {
  const byTerraformAddress = new Map<string, string>()
  for (const resource of existing) {
    if (kindOfResource(resource) !== expectedKind) continue
    if (resource.address === undefined) continue
    // One address, one resource. A duplicate would make the choice arbitrary,
    // so the first wins and the second is ignored — the caller listed the same
    // address twice, which is their ambiguity, not this module's.
    if (!byTerraformAddress.has(resource.address)) byTerraformAddress.set(resource.address, resource.id)
  }

  for (const text of stringsIn(value)) {
    for (const address of addressesOf(text)) {
      const id = byTerraformAddress.get(address)
      if (id !== undefined && byAddress.has(id)) return id
    }
  }
  return undefined
}

/**
 * The body to search for a node's container.
 *
 * For a top-level attribute that is the body itself. For a nested block it is
 * the block's members, flattened — a compute instance may declare several
 * `network` blocks and the subnet is whichever `uuid` resolves first, which is
 * what {@link matchReferenceTarget} already does over a list.
 *
 * @param body - the resource block's body.
 * @param rule - how this kind finds its container.
 * @returns the value to search.
 */
function bodyForRule(
  body: Record<string, unknown>,
  rule: ContainerRule,
): unknown {
  // The two variants are told apart by `block`: the block form carries both
  // `block` and `attribute`, so `'attribute' in rule` is true for both.
  return 'block' in rule ? body[rule.block] : body[rule.attribute]
}

/**
 * Freeze one node and its subtree into the public shape.
 *
 * `ancestors` runs root-most last (`[parent, grandparent, …]`), so the first
 * entry is the box this one is drawn inside and the rest say which VPC that
 * box belongs to.
 */
function freezeNode(node: MutableNode): TopologyNode {
  return {
    address: node.address,
    type: node.type,
    name: node.name,
    kind: node.kind,
    existing: node.existing,
    parent: node.parent,
    ancestors: node.ancestors,
    facts: node.facts,
    children: node.children.map(freezeNode),
  }
}

/**
 * The address one attribute points at, when it points at a known node of the
 * expected kind.
 *
 * The value may reach through several resources; the first reference that
 * resolves to a node of the expected kind is the one that decides containment.
 * A target that is missing, or is of another kind, drops containment rather
 * than guessing.
 *
 * @param value - the attribute's value as written.
 * @param byAddress - every node, by address.
 * @param expectedKind - the kind the target must have.
 * @returns the target's address, or `undefined`.
 */
function matchReferenceTarget(
  value: unknown,
  byAddress: ReadonlyMap<string, MutableNode>,
  expectedKind: NodeKind,
): string | undefined {
  for (const text of stringsIn(value)) {
    for (const address of addressesOf(text)) {
      if (byAddress.get(address)?.kind === expectedKind) return address
    }
  }
  return undefined
}

/** Every address written in one string. */
function addressesOf(text: string): string[] {
  // Same identifier rule as `hcl.referencesOf` — see the note there for why the
  // class is Unicode rather than ASCII.
  const found: string[] = []
  const re = /\$\{\s*([\p{L}_][\p{L}\p{N}_-]*)\.([\p{L}_][\p{L}\p{N}_-]*)/gu
  for (const match of text.matchAll(re)) {
    const [, type, name] = match
    if (type !== undefined && name !== undefined) found.push(`${type}.${name}`)
  }
  return found
}

/**
 * The attributes worth showing on a node's box.
 *
 * A fact appears when it is a literal, or when it names another resource — a
 * relationship a reader wants to see (`security_group_id =
 * huaweicloud_networking_secgroup.web.id`). An attribute set to a variable is
 * omitted: `var.subnet_cidr` says nothing about the network that will exist,
 * and showing it would put unresolvable text on the picture.
 *
 * @param block - the resource block.
 * @param kind - its node kind.
 * @returns the facts, in the kind's configured order.
 */
function displayFacts(
  block: ResourceBlock,
  kind: NodeKind,
): TopologyFact[] {
  const facts: TopologyFact[] = []
  for (const key of DISPLAY_ATTRIBUTES[kind] ?? []) {
    const literal = literalOf(block.body, key)
    if (literal !== undefined) {
      facts.push({ key, value: literal })
      continue
    }
    const raw = block.body[key]
    const reference = typeof raw === 'string' ? firstReference(raw) : undefined
    if (reference !== undefined) facts.push({ key, value: reference })
  }
  return facts
}

/**
 * One drawable relationship.
 *
 * `label` is present only for a connection, and it is what tells a renderer to
 * draw the edge differently: "reachable through this" is a different claim from
 * "refers to this", and a picture that renders both as bare arrows says the
 * wrong thing about one of them.
 */
export interface TopologyEdge {
  readonly from: string
  readonly to: string
  /** The connection kind, when this edge IS a connection between networks. */
  readonly connection?: ConnectionKind
}

/**
 * The relationships a renderer should draw as lines.
 *
 * Two sources, and they mean different things:
 *
 *   1. **A reference** — one resource names another, and the nesting does not
 *      already express it. Every subnet references its VPC's `id`, and the
 *      subnet is also nested inside that VPC; drawing both puts an arrow from
 *      each subnet to the box that already contains it, which reads as a
 *      connection between peers and is the one thing the picture must not say.
 *      Containment is expressed by the nesting alone.
 *   2. **A connection** — a peering, an endpoint or a route joins two VPCs.
 *      These are not references at all: the resource exists to state that the
 *      two networks can reach each other, so it becomes a LABELLED edge and the
 *      resource itself is not a box.
 *
 * References to resources the topology does not know (a `data.` source, a
 * variable's members) are dropped: an edge needs two boxes, and inventing one
 * would present a relationship that may not exist.
 *
 * @param blocks - every resource block.
 * @param topology - the derived topology, whose addresses are the drawable ones.
 * @returns one entry per drawable relationship.
 */
export function edgesOf(
  blocks: readonly ResourceBlock[],
  topology: Topology,
): TopologyEdge[] {
  const known = new Set(topology.nodes.map(node => node.address))
  const parentOf = new Map(topology.nodes.map(node => [node.address, node.parent]))
  const seen = new Set<string>()
  const edges: TopologyEdge[] = []

  for (const connection of topology.connections) {
    const { from, to } = connection
    if (from === undefined || to === undefined || from === to) continue
    if (!known.has(from) || !known.has(to)) continue
    const key = `${from}\u0000${to}\u0000${connection.kind}`
    if (seen.has(key)) continue
    seen.add(key)
    edges.push({ from, to, connection: connection.kind })
  }

  for (const block of blocks) {
    const from = `${block.type}.${block.name}`
    if (!known.has(from)) continue
    for (const reference of referencesOf(block.body)) {
      if (!known.has(reference) || reference === from) continue
      // Already shown by the nesting.
      if (parentOf.get(from) === reference) continue
      const key = `${from}\u0000${reference}`
      if (seen.has(key)) continue
      seen.add(key)
      edges.push({ from, to: reference })
    }
  }
  return edges
}