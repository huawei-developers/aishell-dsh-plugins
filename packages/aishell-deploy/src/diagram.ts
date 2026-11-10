/**
 * Turning the account into the diagram's node tree.
 *
 * ## The three layers, and how each becomes a shape
 *
 * `account-view.ts` reads three kinds of fact. Each has exactly one right
 * drawing, and picking the wrong one is what makes a diagram misleading:
 *
 *   - **Placement and attachment** become NESTING. A subnet is inside its VPC;
 *     a server is inside its subnet; an EIP is inside the load balancer it
 *     answers for. All four are the same claim — "this belongs to that" — and a
 *     line between them would say "related", which is weaker and untrue.
 *   - **Guarding** becomes TEXT INSIDE the guarded box. A security group is not
 *     a peer of the server it protects; it is a property of it. Drawing it as a
 *     node with an arrow turns a setting into an entity.
 *   - **Policy** becomes an EDGE, in its own band, with the port on it. This is
 *     the only relationship in the picture that expresses reachability, and the
 *     only one where direction and port mean anything.
 *
 * ## What the picture contains, in order
 *
 * The VPCs and their contents, then a band of the account-level services that
 * belong to no network, then the policy band. Everything the account holds is
 * somewhere; nothing is dropped for being uninteresting, because "uninteresting"
 * would be a rule and a rule needs a source that does not exist here.
 *
 * @module @huaweidevtools/aishell-dsh-deploy/diagram
 */

import type { LayoutNode } from './layout.ts'
import { layoutTree } from './layout.ts'
import { renderDiagram } from './svg-render.ts'
import type { BoxEdge, BoxRole, Diagram } from './svg-render.ts'
import { accountView, groupUsers, ruleSummaries } from './account-view.ts'
import type { RuleSummary } from './account-view.ts'
import { policyContinuations, trafficPaths } from './traffic.ts'
import type { AccountResource } from './account-view.ts'


/**
 * The lines a security group's rules become, inside the box they guard.
 *
 * Ingress first, then egress, each rule on its own line. The verbs are
 * `in`/`out` rather than the provider's `ingress`/`egress`: a box is scanned,
 * and the direction is the first thing a reader checks.
 *
 * @param summaries - the rules worth showing for the groups guarding a box.
 * @returns the detail lines, or an empty list when there are none.
 */
function ruleLines(
  summaries: readonly { readonly ingress: readonly RuleSummary[], readonly egress: readonly RuleSummary[] }[],
): string[] {
  const lines: string[] = []
  for (const bucket of summaries) {
    for (const rule of bucket.ingress) {
      lines.push(`in  ${rule.protocol} ${rule.ports} \u2190 ${rule.source}`)
    }
    for (const rule of bucket.egress) {
      lines.push(`out ${rule.protocol} ${rule.ports} \u2192 ${rule.source}`)
    }
  }
  return lines
}

/** What a box is, for the renderer and for the tests. */
interface TreeNode {
  readonly id: string
  readonly label: string
  readonly role: BoxRole
  /** The service that reported it, for the renderer's tint. Empty for a band. */
  readonly provider: string
  /** Detail lines drawn under the label, left-aligned. */
  readonly lines: readonly string[]
  /** A count shown centred under the lines. */
  readonly figure?: string
  readonly children: TreeNode[]
}

/**
 * The text a resource's box shows.
 *
 * The name first — that is what the console and every other tool call it by —
 * then the one fact that makes it recognisable: a subnet's CIDR, a server's
 * flavour. Everything else is left out, because a box whose label is a dump of
 * properties cannot be scanned.
 *
 * @param resource - the resource.
 * @returns the label.
 */
function labelOf(resource: AccountResource): string {
  const name = resource.name ?? resource.id.slice(0, 8)
  const properties = resource.properties ?? {}
  const detail = typeof properties['cidr'] === 'string'
    ? properties['cidr']
    : typeof properties['flavor'] === 'string'
      ? properties['flavor']
      : typeof properties['flavorCode'] === 'string'
        ? properties['flavorCode']
        : typeof properties['publicIpAddress'] === 'string'
          ? properties['publicIpAddress']
          : undefined
  return detail === undefined || detail === name ? name : `${name}  ${detail}`
}

/**
 * Build the node tree for one group of resources.
 *
 * @param members - the resources to include.
 * @param parentOf - the resolved containment.
 * @param guardsOf - the resolved guarding.
 * @param excluded - ids handled elsewhere (the policy band).
 * @returns the nodes, with the topmost ones returned rather than nested.
 */
function treeOf(
  members: readonly AccountResource[],
  parentOf: ReadonlyMap<string, string>,
  guardsOf: ReadonlyMap<string, readonly string[]>,
  excluded: ReadonlySet<string>,
  summaryByName: ReadonlyMap<string, { readonly ingress: readonly RuleSummary[], readonly egress: readonly RuleSummary[] }>,
): TreeNode[] {
  const present = new Set(members.map(resource => resource.id))

  // Which members hold other members, decided before any node is built so the
  // node's role is known when it is constructed rather than assigned after.
  const holds = new Set<string>()
  for (const resource of members) {
    const parent = parentOf.get(resource.id)
    if (parent !== undefined && present.has(parent)) holds.add(parent)
  }

  const nodes = new Map<string, TreeNode>()
  const build = (resource: AccountResource): TreeNode => {
    const existing = nodes.get(resource.id)
    if (existing !== undefined) return existing
    const guards = guardsOf.get(resource.id) ?? []
    const label = guards.length === 0
      ? labelOf(resource)
      : `${labelOf(resource)}  ·  SG ${guards.join(', ')}`
    const node: TreeNode = {
      id: resource.id,
      provider: resource.provider,
      label: label,
      lines: ruleLines(guards.map(name => summaryByName.get(name)).filter((x): x is NonNullable<typeof x> => x !== undefined)),
      role: holds.has(resource.id) ? 'container' : 'resource',
      children: [],
    }
    nodes.set(resource.id, node)
    return node
  }

  const roots: TreeNode[] = []
  const nested = new Set<string>()
  for (const resource of members) {
    if (excluded.has(resource.id)) continue
    const parent = parentOf.get(resource.id)
    // Only nest when the parent is in this group: a subnet's parent is a VPC
    // that the caller has already nested, and re-nesting it here would draw it
    // twice.
    if (parent === undefined || !present.has(parent)) {
      roots.push(build(resource))
      continue
    }
    nodes.get(parent)?.children.push(build(resource))
    nested.add(resource.id)
  }

  for (const resource of members) {
    if (nested.has(resource.id) || excluded.has(resource.id)) continue
    if (!roots.some(root => root.id === resource.id)) roots.push(build(resource))
  }
  return roots
}

/**
 * Convert the tree into the layout's shape.
 *
 * @param node - the tree node.
 * @returns the layout node.
/**
 * Convert the tree into the layout's shape.
 *
 * @param node - the tree node.
 * @returns the layout node.
 */
function toLayoutNode(node: TreeNode): LayoutNode {
  return {
    id: node.id,
    label: node.label,
    ...(node.provider === '' ? {} : { provider: node.provider }),
    ...(node.lines.length === 0 ? {} : { detail: node.lines }),
    ...(node.figure === undefined ? {} : { figure: node.figure }),
    children: node.children.map(child => toLayoutNode(child)),
  }
}

/**
 * Build the drawable diagram for an account.
 *
 * @param resources - everything the inventory reported.
 * @returns the placed boxes, the policy edges, and each box's role.
 */
export function buildDiagram(resources: readonly AccountResource[]): Diagram {
  const view = accountView(resources)
  const byId = new Map(resources.map(resource => [resource.id, resource]))

  // Rule summaries keyed by the group's NAME, because that is what a resource's
  // guarding field holds — `security_group_id` names an id, but the label shows
  // the name, and the two are resolved once here rather than at each box.
  const summaries = ruleSummaries(resources)
  const summaryByName = new Map(
    resources
      .filter(resource => summaries.has(resource.id))
      .map(resource => [resource.name ?? resource.id, summaries.get(resource.id)!]),
  )

  // ── The network side ────────────────────────────────────────────────────
  //
  // Start from each VPC and pull in everything it transitively contains. A
  // resource that belongs to no VPC — a security group, an EIP, a log group —
  // is collected into a band instead of being left as a root of its own.
  const childrenOf = new Map<string, string[]>()
  for (const [child, parent] of view.parentOf) {
    childrenOf.set(parent, [...(childrenOf.get(parent) ?? []), child])
  }

  // ── Regions, VPCs and their contents ────────────────────────────────────
  //
  // The outermost division is the region, because several things only make
  // sense inside one: a security group named `default` exists once per region,
  // and the same name means a different group in each. Grouping by region is
  // what lets those names be told apart without renaming anything.
  const regions = new Map<string, AccountResource[]>()
  for (const resource of resources) {
    const region = resource.region ?? 'unknown'
    regions.set(region, [...(regions.get(region) ?? []), resource])
  }

  const claimed = new Set<string>()

  /** Build one resource's node, with its guards shown inside it. */
  const nodeFor = (resource: AccountResource): TreeNode => ({
    id: resource.id,
    provider: resource.provider,
    label: ((): string => {
      const guards = view.guardsOf.get(resource.id) ?? []
      return guards.length === 0
        ? labelOf(resource)
        : `${labelOf(resource)}  ·  SG ${guards.join(', ')}`
    })(),
    lines: ruleLines((view.guardsOf.get(resource.id) ?? [])
      .map(name => summaryByName.get(name))
      .filter((x): x is NonNullable<typeof x> => x !== undefined)),
    role: (childrenOf.get(resource.id) ?? []).length > 0 ? 'container' : 'resource',
    children: [],
  })

  /** Attach every descendant of `parentId`, depth first. */
  const attachBelow = (parent: TreeNode, parentId: string): void => {
    for (const childId of childrenOf.get(parentId) ?? []) {
      if (claimed.has(childId)) continue
      claimed.add(childId)
      const resource = byId.get(childId)
      if (resource === undefined) continue
      const node = nodeFor(resource)
      parent.children.push(node)
      attachBelow(node, childId)
    }
  }

  const regionTrees: TreeNode[] = []
  for (const [region, members] of [...regions].sort((a, b) => a[0].localeCompare(b[0]))) {
    const inRegion = new Set(members.map(resource => resource.id))
    // A region is a synthetic box: no single resource reported it, so it has no
    // service to take a tint from.
    const regionNode: TreeNode = {
      id: `region:${region}`, label: region, role: 'container', provider: '', lines: [], children: [],
    }

    // A VPC is drawn first, with everything it transitively holds.
    for (const vpc of members.filter(resource => resource.type === 'vpcs')) {
      claimed.add(vpc.id)
      const vpcNode: TreeNode = {
        id: vpc.id,
        provider: vpc.provider,
        label: labelOf(vpc),
        role: 'container',
        lines: [],
        children: [],
      }
      attachBelow(vpcNode, vpc.id)
      regionNode.children.push(vpcNode)
    }

    regionTrees.push(regionNode)
    // Whatever the region holds that no VPC claimed is placed by the bands
    // below, restricted to this region so a same-named resource cannot drift.
    void inRegion
  }

  // ── The bands ───────────────────────────────────────────────────────────
  //
  // What no VPC claimed. Split by whether it is something a network USES (the
  // platform services) or something that belongs to the account but not to any
  // network (logs, buckets, keys). The policy groups are left out of both: they
  // are shown in the policy band, where their relationships are visible.
  // Every resource that no VPC claimed goes into its region's band, security
  // groups included. Pulling the ones that take part in a policy into a
  // separate top-level box drew the same kind of object in two places depending
  // on whether its rules happened to point at another group — a distinction the
  // reader cannot see and has no reason to expect.
  const unclaimed = resources.filter(resource => (
    !claimed.has(resource.id)
    && resource.type !== 'vpcs'
  ))

  /**
   * Which resources are shown as TEXT on something else rather than as a box.
   *
   * A security group and a bandwidth are properties of what they serve: the
   * value that names them is on the served resource, and the group's rules
   * already appear inside that resource's box. Drawing them again as boxes puts
   * the same object in two places, and a group that serves three things in one.
   */
  // ── Two bands per region, and what goes in each ─────────────────────────
  //
  //   - **Security groups** holds every group of the region. A group is a
  //     region-level object: the provider reports no VPC for one, and for the
  //     `default` group that is not missing data but the truth. Drawing a group
  //     inside a VPC would claim a containment the account does not have.
  //
  //     Each group's box shows what USES it, because a group's rules say what
  //     it admits and its users say whether it matters: 13 groups exist on a
  //     live account and 6 are used by anything.
  //
  //   - **Unattached** holds what has no container and no better place: buckets,
  //     log groups, key pairs, trackers.
  //
  // A bandwidth is neither: it is a property of the address it meters, already
  // named by the EIP that consumes it, so it is drawn on that EIP's box instead.
  const users = groupUsers(resources)

  /** The rule lines one security group's box carries, ingress first. */
  const groupLines = (group: AccountResource): string[] => {
    const bucket = summaryByName.get(group.name ?? '')
    if (bucket === undefined) return []
    const lines: string[] = []
    for (const rule of bucket.ingress) {
      lines.push(`in  ${rule.protocol} ${rule.ports} \u2190 ${rule.source}`)
    }
    for (const rule of bucket.egress) {
      lines.push(`out ${rule.protocol} ${rule.ports} \u2192 ${rule.source}`)
    }
    return lines
  }

  /**
   * The figure a security group's box shows: how many resources use it.
   *
   * A single number, drawn centred and larger than the rules, because it answers
   * a different question — is this group alive — and a reader should be able to
   * tell live from leftover without reading a line of text.
   */
  const groupFigure = (group: AccountResource): string => (
    String((users.get(group.id) ?? []).length)
  )

  for (const regionNode of regionTrees) {
    const region = regionNode.label
    const mine = unclaimed.filter(resource => (resource.region ?? 'unknown') === region)

    const groups = mine.filter(resource => resource.type === 'securityGroups')
    if (groups.length > 0) {
      regionNode.children.push({
        id: `band:security:${region}`,
        label: 'Security groups',
        role: 'container',
        provider: '',
        lines: [],
        children: [...groups]
          .sort((a, b) => (a.name ?? '').localeCompare(b.name ?? ''))
          .map(group => ({
            id: group.id,
            provider: group.provider,
            label: group.name ?? group.id,
            lines: groupLines(group),
            figure: groupFigure(group),
            role: 'resource' as const,
            children: [],
          })),
      })
    }

    // Everything else with no container. A bandwidth is skipped: the EIP that
    // consumes it already names it.
    const loose = mine.filter(resource => (
      resource.type !== 'securityGroups' && resource.type !== 'bandwidths'
    ))
    if (loose.length === 0) continue
    const kids = treeOf(loose, view.parentOf, view.guardsOf, new Set(), summaryByName)
    const sorted = [...kids].sort((a, b) => a.label.localeCompare(b.label))
    regionNode.children.push({
      id: `band:loose:${region}`,
      label: 'Unattached',
      role: 'container',
      provider: '',
      lines: [],
      children: sorted,
    })
  }

  const roots: TreeNode[] = regionTrees

  const layout = layoutTree(roots.map(root => toLayoutNode(root)))

  // ── Roles, by id ────────────────────────────────────────────────────────
  const roles = new Map<string, BoxRole>()
  const note = (node: TreeNode): void => {
    roles.set(node.id, node.role)
    for (const child of node.children) note(child)
  }
  for (const root of roots) note(root)

  // ── Edges ───────────────────────────────────────────────────────────────
  //
  // Two kinds, drawn differently because they say different things:
  //
  //   - A TRAFFIC hop is "packets go here, this way, on this port". It is the
  //     chain from the internet inwards, and it is the reason a reader opens
  //     this picture.
  //   - A POLICY edge is "this group admits that one". It is a rule, not a
  //     flow; nothing travels along it.
  //
  // Both are keyed by the resource whose box they attach to, so an edge is only
  // drawn when both ends were placed — a group with no box, or a hop to a
  // resource that is not in the picture, is skipped rather than invented.
  const edges: BoxEdge[] = []

  // No policy edges. A rule between two groups is drawn on the boxes now:
  // the group's own box says what it admits and who uses it, and an arrow
  // between two boxes in the same band would restate the same fact across a
  // space of a few pixels. Measured on the live account, three policy edges
  // exist and all three connect groups inside one region.
  void view.policies

  // A traffic path is a chain, so it becomes one arrow per hop rather than one
  // long arrow: the port belongs to the hop it is on, and a single arrow from
  // the internet to a cluster would have nowhere to put it.
  //
  // The internet is not a box, so the first hop is skipped — the EIP's box is
  // the first thing the picture can point at, and its label already says it is
  // a public address.
  // A hop between a container and something it holds is ALREADY drawn — by the
// nesting. An EIP inside its balancer, a listener inside the balancer that owns
// it: the box says "this is part of that", and an arrow between them would say
// the same thing twice while crossing the container's border to do it.
  //
  // So only a hop that leaves its container becomes an arrow. That is the
  // relationship a reader has to follow, and the only one the nesting cannot
  // state.
  const ambiguous = new Set<string>()
  for (const [child, parent] of view.parentOf) ambiguous.add(`${child}\u0000${parent}`)

  for (const path of trafficPaths(resources)) {
    for (let index = 0; index < path.hops.length - 1; index++) {
      const from = path.hops[index]!
      const to = path.hops[index + 1]!
      if (from.id === undefined || to.id === undefined) continue
      if (!roles.has(from.id) || !roles.has(to.id)) continue
      // Containment in either direction: the nesting states it.
      if (ambiguous.has(`${from.id}\u0000${to.id}`)) continue
      if (ambiguous.has(`${to.id}\u0000${from.id}`)) continue
      edges.push({
        from: from.id,
        to: to.id,
        label: to.detail ?? from.detail ?? '',
        kind: 'traffic',
      })
    }
  }

  // A chain that ends at a cluster still has somewhere to go when the account
  // states it: the group guarding that cluster, and the group that admits the
  // database, together say the pods reach it. See `policyContinuations` for
  // when that extra hop is drawn and when it is refused.
  for (const [from, hop] of policyContinuations(resources, view)) {
    if (hop.id === undefined) continue
    if (!roles.has(from) || !roles.has(hop.id)) continue
    edges.push({
      from,
      to: hop.id,
      label: hop.detail ?? '',
      kind: 'traffic',
    })
  }

  return {
    width: layout.width,
    height: layout.height,
    boxes: layout.boxes,
    edges,
    roles,
  }
}

/**
 * Draw the account as a diagram.
 *
 * @param resources - everything the inventory reported.
 * @returns the SVG and a text record of what it shows.
 */
export function renderAccountDiagram(resources: readonly AccountResource[]): {
  readonly diagram: Diagram
  readonly svg: string
  readonly source: string
} {
  const diagram = buildDiagram(resources)
  return { diagram, svg: renderDiagram(diagram), source: describe(diagram) }
}

/**
 * A readable text form of the diagram, written beside the SVG.
 *
 * It is not D2 any more and does not claim to be: it records the nesting and the
 * policy edges as indented text, which is what a reader opens it for.
 *
 * @param diagram - the built diagram.
 * @returns the text.
 */
function describe(diagram: Diagram): string {
  const lines: string[] = []
  const walk = (box: (typeof diagram.boxes)[number], depth: number): void => {
    lines.push(`${'  '.repeat(depth)}${box.label}`)
    for (const child of box.children) walk(child, depth + 1)
  }
  for (const root of diagram.boxes.filter(box => box.depth === 0)) walk(root, 0)
  if (diagram.edges.length > 0) {
    lines.push('', 'policy:')
    for (const edge of diagram.edges) lines.push(`  ${edge.from} -> ${edge.to}  (${edge.label})`)
  }
  return lines.join('\n')
}