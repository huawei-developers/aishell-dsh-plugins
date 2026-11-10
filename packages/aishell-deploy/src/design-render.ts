/**
 * Drawing a design with the same layout and renderer as an account.
 *
 * ## Why the two pictures share a renderer
 *
 * A design and an account answer different questions, but they are the same
 * KIND of picture: nested network regions with a few connectors between them.
 * They were drawn by different engines, which meant the same deployment could
 * produce two diagrams whose boxes, spacing and colours did not match — and a
 * reader comparing "what I planned" against "what is running" had to do the
 * mapping in their head.
 *
 * ## What stays different
 *
 * The input vocabulary. A design's nodes are already classified
 * (`vpc`, `subnet`, `security-group`, …) because the classification is what
 * `topology.ts` decides from the configuration; an account's are not, because
 * the inventory names things in its own terms. That difference stops at this
 * module: both become a `LayoutNode` tree, and everything downstream is
 * identical.
 *
 * The one thing the design renderer adds is the distinction the account does
 * not have: a node may be `existing` — a resource the deployment reuses rather
 * than creates — and it is drawn dashed so a reviewer can see at a glance what
 * is already there.
 *
 * @module @huaweidevtools/aishell-dsh-deploy/design-render
 */

import type { Topology, TopologyEdge, TopologyNode } from './topology.ts'
import { layoutTree } from './layout.ts'
import type { LayoutNode } from './layout.ts'
import { renderDiagram } from './svg-render.ts'
import type { BoxEdge, BoxRole, Diagram } from './svg-render.ts'

/**
 * The word a box is headed with, by kind.
 *
 * Written out rather than derived from the kind name because the kind is this
 * module's vocabulary (`security-group`) while the box is read by someone
 * looking at a network diagram and needs the words the cloud uses.
 *
 * `compute` and `database` cover several provider types, so their captions stay
 * generic: a CCE node is not an ECS instance, and a box captioned "ECS" would
 * claim it is.
 */
const KIND_CAPTION: Readonly<Record<string, string>> = {
  vpc: 'VPC',
  subnet: 'subnet',
  'security-group': 'secgroup',
  'security-group-rule': 'rule',
  gateway: 'gateway',
  'load-balancer': 'ELB',
  compute: 'compute',
  database: 'database',
}

/**
 * The text a design node's box shows.
 *
 * A rule leads with its EFFECT rather than its name: `ingress 22 ← 0.0.0.0/0`
 * says what it admits, which is what a reviewer checks. Every other kind leads
 * with its cloud name, falling back to the terraform label — the label is what
 * addresses and tool results use, but the cloud name is what the console shows.
 *
 * @param node - the design node.
 * @returns one line of text.
 */
export function designLabel(node: TopologyNode): string {
  const facts = new Map(node.facts.map(fact => [fact.key, fact.value]))

  if (node.kind === 'security-group-rule') {
    const direction = facts.get('direction') ?? '?'
    const ports = facts.get('ports') ?? 'all ports'
    const remote = facts.get('remote_ip_prefix')
    const arrow = direction === 'egress' ? '→' : '←'
    return remote === undefined
      ? `${direction} ${ports}`
      : `${direction} ${ports} ${arrow} ${remote}`
  }

  const caption = KIND_CAPTION[node.kind] ?? node.kind
  const head = `${caption} ${facts.get('name') ?? node.name}`
  const shown = node.facts
    .filter(fact => fact.key !== 'name')
    .map(fact => fact.value)
  return shown.length === 0 ? head : `${head}  ${shown.join(' · ')}`
}

/**
 * Convert a design node into the layout tree's shape.
 *
 * @param node - the design node.
 * @returns the layout node.
 */
function toLayoutNode(node: TopologyNode): LayoutNode {
  return {
    id: node.address,
    label: designLabel(node),
    // A design's nodes are terraform resources, so the service is the type's
    // own prefix: `huaweicloud_vpc_subnet` is a `vpc` resource. That gives a
    // design the same service tinting an account gets, which is what makes the
    // two pictures comparable.
    provider: node.type.replace(/^huaweicloud_/, '').split('_')[0] ?? '',
    // A reused resource keeps its dashed frame all the way down: a subnet that
    // already exists contains instances that already exist.
    existing: node.existing,
    children: node.children.map(child => toLayoutNode(child)),
  }
}

/**
 * Build the drawable diagram for a design.
 *
 * @param topology - the derived design.
 * @param edges - the relationships to draw, already filtered to what nesting
 *   does not express.
 * @returns the placed boxes, the connectors, and each box's role.
 */
export function buildDesignDiagram(
  topology: Topology,
  edges: readonly TopologyEdge[],
): Diagram {
  const layout = layoutTree(topology.roots.map(root => toLayoutNode(root)))

  const roles = new Map<string, BoxRole>()
  const note = (node: TopologyNode): void => {
    roles.set(node.address, node.children.length > 0 ? 'container' : 'resource')
    for (const child of node.children) note(child)
  }
  for (const root of topology.roots) note(root)

  // A connection between networks is a labelled edge — it is the one
  // relationship the nesting cannot express. A plain reference is not drawn
  // again: the boxes already say where everything lives.
  const boxEdges: BoxEdge[] = []
  for (const edge of edges) {
    if (!roles.has(edge.from) || !roles.has(edge.to)) continue
    boxEdges.push({
      from: edge.from,
      to: edge.to,
      label: edge.connection === undefined ? '' : CONNECTION_LABEL[edge.connection] ?? edge.connection,
      kind: 'traffic',
    })
  }

  return {
    width: layout.width,
    height: layout.height,
    boxes: layout.boxes,
    edges: boxEdges,
    roles,
  }
}

/** The words on a connection's arrow: the cloud's own term, not this module's. */
const CONNECTION_LABEL: Readonly<Record<string, string>> = {
  peering: 'peering',
  endpoint: 'VPCEP',
  route: 'route',
}

/**
 * Draw the design.
 *
 * @param topology - the derived design.
 * @param edges - the relationships to draw.
 * @returns the SVG and a text record of what it shows.
 */
export function renderDesignDiagram(
  topology: Topology,
  edges: readonly TopologyEdge[],
): { readonly diagram: Diagram, readonly svg: string, readonly source: string } {
  const diagram = buildDesignDiagram(topology, edges)
  return { diagram, svg: renderDiagram(diagram), source: describe(diagram) }
}

/**
 * A readable text form of the design, written beside the SVG.
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
    lines.push('', 'connections:')
    for (const edge of diagram.edges) lines.push(`  ${edge.from} -> ${edge.to}  (${edge.label})`)
  }
  return lines.join('\n')
}