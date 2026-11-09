/**
 * Drawing a design: what a `.tf` declares, with the resources it reuses marked.
 *
 * ## Why this module does have a table of kinds
 *
 * Its input is `Topology`, whose nodes have already been classified into a
 * design vocabulary (`vpc`, `subnet`, `security-group`, …). That
 * classification is the point of the design path: a design is a network
 * configuration, and the picture is about the network it declares. A resource
 * outside that vocabulary is reported by name rather than drawn — see
 * `topology.ts`.
 *
 * So the tables here map that closed vocabulary onto colour and words. They are
 * finite because the input is finite, and a kind added to `NodeKind` without a
 * class here fails at generation, naming the fragment.
 *
 * An account that already exists draws through `d2-inventory.ts` instead, where
 * the vocabulary has no closed form.
 *
 * ## What D2 carries
 *
 * The PICTURE. Not data: an attribute written as a child (`cidr: "10.0.0.0/16"`)
 * becomes a visible second box, so facts go into the node's LABEL instead. A
 * mistyped attribute or an edge to an undefined node is accepted silently.
 *
 * @module @huaweidevtools/aishell-dsh-deploy/d2-design
 */

import type { Finding, Topology, TopologyEdge, TopologyNode } from './topology.ts'
import { d2Id, quote, renderD2, themePreamble } from './d2-engine.ts'
import type { RenderResult } from './d2-engine.ts'

/**
 * The D2 palette classes per node kind.
 *
 * These are D2's OWN theme classes (`fill-B4`, `stroke-B1`, …), not custom
 * colours, and that is the whole reason for using them. A custom
 * `classes: { vpc: { style: { fill: "#EEF4FF" } } }` is emitted as a
 * hard-coded `fill="#EEF4FF"` on the element, so it stays light-blue on a dark
 * ground and the diagram becomes unreadable. The built-in classes are emitted
 * as class REFERENCES, and D2 writes both palettes into the SVG with the dark
 * half behind `@media (prefers-color-scheme: dark)` — so one file follows the
 * viewer's theme with no JavaScript.
 *
 * The hues are D2's accent ramps: `B` (blue) for network structure, `AA` (red)
 * for the one kind that is a warning by nature, and `N` (neutral) for anything
 * unrecognised. Lightness steps apart so a subnet reads as inside its VPC.
 */
const KIND_CLASSES: Readonly<Record<string, string>> = {
  // Outer container: a darker step than what it holds, so nested boxes visibly
  // sit inside it.
  vpc: 'fill-B5, stroke-B3',
  // Lighter than the VPC it sits in.
  subnet: 'fill-B6, stroke-B4',
  // Violet, because a security group is what admits traffic and is the one kind
  // a reviewer has to read rule by rule.
  'security-group': 'fill-AA4, stroke-AA2',
  // Violet-coded like its group, but the lightest step: a rule is a detail of
  // the group, not a peer of it.
  'security-group-rule': 'fill-AA5, stroke-AA4',
  // Neutral: a gateway is plumbing, not part of the address plan.
  gateway: 'fill-N6, stroke-N4',
  'load-balancer': 'fill-B4, stroke-B2',
  // Teal: these are what the deployment is FOR, and they read as distinct from
  // the network fabric that carries them.
  compute: 'fill-AB5, stroke-AB4',
  database: 'fill-AB4, stroke-AB4',
}

/**
 * The short noun a node's box is headed with.
 *
 * The design vocabulary's names are this module's own (`security-group`), while
 * the box is read by someone looking at a network diagram and needs the words
 * the cloud uses.
 *
 * `compute` and `database` are the two kinds that cover several provider types,
 * so their captions are the generic word rather than one product name: a CCE
 * node is not an ECS instance and a DDS cluster is not RDS, and a box captioned
 * "ECS" would claim it is. The node's own `name` and terraform type carry the
 * specific identity.
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
 * The words on a connection's arrow.
 *
 * The cloud's own term for each, not this module's: a reader who looks at the
 * console finds "对等连接", "终端节点" and "路由" — and a diagram that renamed
 * them would need a translation step nobody asked for.
 */
const CONNECTION_LABEL: Readonly<Record<string, string>> = {
  peering: 'peering',
  endpoint: 'VPCEP',
  route: 'route',
}

/**
 * The D2 class an edge carries.
 *
 * D2's connection classes take the same palette vocabulary as shapes, so the
 * connection uses the accent that reads as "traffic flows here" rather than the
 * neutral a plain reference gets. It is a theme class, not a literal colour, so
 * the dark palette follows.
 */
const CONNECTION_CLASS = 'stroke-AB3'

/**
 * Draw the topology.
 *
 * @param topology - the derived picture.
 * @param edges - the relationships to draw, from `<from-address>` to
 *   `<to-address>`. Only addresses the topology knows are drawn.
 * @returns the D2 source and the SVG it renders to.
 * @throws when the generated D2 source does not compile. That is a defect in
 *   this module rather than in the user's configuration — the generator is
 *   what produced the text — so the message names the generated fragment.
 */
export async function renderTopology(
  topology: Topology,
  edges: readonly TopologyEdge[],
): Promise<RenderResult> {
  const source = toD2(topology, edges)
  return { source, svg: await renderD2(source) }
}

/**
 * Generate the D2 source for one topology.
 *
 * The shape of the output is fixed by what D2 accepts:
 *
 *   - Nothing is written as an attribute child. `cidr: "10.0.0.0/16"` inside a
 *     node's block renders as its own box, which would put a stray rectangle
 *     in every subnet. Facts go into the node's LABEL instead.
 *   - Facts are separated by `·` rather than aligned into columns, because D2
 *     treats a leading `|` as a block-string terminator.
 *   - No `vars` block beyond the theme: D2 discards everything under it except
 *     `d2-config`.
 *
 * @param topology - the derived picture.
 * @param edges - the relationships to draw.
 * @returns D2 source text.
 */
export function toD2(
  topology: Topology,
  edges: readonly TopologyEdge[],
): string {
  // The theme ids are written into the diagram rather than passed to `render`,
  // so the generated source is the whole description of what was drawn — a
  // reader feeding it to the D2 CLI gets the same colours.
  const lines: string[] = themePreamble()

  const byAddress = new Map(topology.nodes.map(node => [node.address, node]))
  for (const root of topology.roots) lines.push(...nodeLines(root, 0))
  if (topology.roots.length > 0) lines.push('')

  // An edge needs both boxes to exist. A reference to something the topology
  // did not place (a data source, a variable) is not drawable, and drawing it
  // against a node D2 would invent presents a relationship that may not exist.
  for (const edge of edges) {
    const from = byAddress.get(edge.from)
    const to = byAddress.get(edge.to)
    if (from === undefined || to === undefined) continue
    if (edge.connection === undefined) {
      lines.push(`${d2Id(edge.from)} -> ${d2Id(edge.to)}`)
      continue
    }
    // A connection is labelled and styled apart from a plain reference: "these
    // two networks are reachable from each other, this way" is a different
    // claim from "this one names that one", and a bare arrow would say the
    // first thing about both.
    const label = CONNECTION_LABEL[edge.connection]
    if (label === undefined) {
      // Every ConnectionKind has a label; a missing one means a kind was added
      // without the words for it, which would draw an undeclared claim.
      throw new Error(`no label for connection kind "${edge.connection}" (${edge.from} -> ${edge.to})`)
    }
    lines.push(
      `${d2Id(edge.from)} -> ${d2Id(edge.to)}: ${quote(label)} { class: [${CONNECTION_CLASS}] }`,
    )
  }

  const panel = findingsPanel(topology.findings)
  if (panel !== undefined) lines.push('', panel)

  return lines.join('\n')
}

/**
 * One node and its children, as D2 block lines.
 *
 * The label carries the facts, because D2 has no other place for them. A leaf
 * is written as `id: "label" { class: kind }`; a container additionally opens
 * a block so its children nest inside it.
 *
 * @param node - the node to write.
 * @param depth - indentation depth, for nesting.
 * @returns the lines for this node and its subtree.
 */
function nodeLines(node: TopologyNode, depth: number): string[] {
  const indent = '  '.repeat(depth)
  const label = d2Label(node)
  const classes = KIND_CLASSES[node.kind]
  if (classes === undefined) {
    // The topology never produces a kind this table lacks. Written as a refusal
    // rather than a fallback so that adding a kind and forgetting the class
    // fails here, where the generated fragment is named, instead of drawing an
    // unstyled box nobody notices.
    throw new Error(`no D2 class for node kind "${node.kind}" (${node.address})`)
  }
  const style = `class: [${classes}]`
  // Resources that already exist are dashed: the reader can tell at a glance
  // which boxes this deployment will create and which it will use.
  const extra = node.existing ? ['style.stroke-dash: 4'] : []
  if (node.children.length === 0) {
    if (extra.length === 0) {
      return [`${indent}${d2Id(node.address)}: ${quote(label)} { ${style} }`]
    }
    // A leaf with a style needs a block; D2 has no one-line form carrying both.
    return [
      `${indent}${d2Id(node.address)}: ${quote(label)} {`,
      `${indent}  ${style}`,
      ...extra.map(line => `${indent}  ${line.trim()}`),
      `${indent}}`,
    ]
  }
  return [
    `${indent}${d2Id(node.address)}: ${quote(label)} {`,
    `${indent}  ${style}`,
    ...extra.map(line => `${indent}  ${line.trim()}`),
    ...node.children.flatMap(child => nodeLines(child, depth + 1)),
    `${indent}}`,
  ]
}

/**
 * The text drawn on a node's box.
 *
 * A rule leads with its EFFECT rather than its name, because the name is the
 * model's own label (`https`, `ssh`) and the effect is what a reviewer has to
 * check: `ingress 22 ← 0.0.0.0/0` says what the rule admits. Every other kind
 * leads with its name, which is what the configuration and every other tool
 * call it by.
 *
 * Facts that would repeat the leading text are dropped rather than printed
 * twice.
 *
 * @param node - the node to label.
 * @returns one line of text.
 */
function d2Label(node: TopologyNode): string {
  const facts = new Map(node.facts.map(fact => [fact.key, fact.value]))
  if (node.kind === 'security-group-rule') {
    const direction = facts.get('direction') ?? '?'
    const ports = facts.get('ports') ?? 'all ports'
    const remote = facts.get('remote_ip_prefix')
    const arrow = direction === 'egress' ? '→' : '←'
    const target = remote === undefined ? '' : ` ${arrow} ${remote}`
    return `${direction} ${ports}${target}`
  }
  // Two names exist and they are different things: the terraform label (`prod`,
  // which addresses and tool results use) and the cloud `name` attribute
  // (`prod-vpc`, which the console shows). A diagram is read against the
  // console, so the cloud name leads, and the terraform label is what it falls
  // back to — for a rule, which has no `name` attribute, that is the only name
  // there is.
  const kind = KIND_CAPTION[node.kind] ?? node.kind
  const head = `${kind} ${facts.get('name') ?? node.name}`
  const shown = node.facts
    .filter(fact => fact.key !== 'name')
    .map(fact => fact.value)
  return shown.length === 0 ? head : `${head}  ${shown.join(' · ')}`
}

/**
 * The findings block, when there are findings.
 *
 * Written as a markdown block pinned below the diagram, so the problems sit
 * beside the picture they describe rather than in a separate message a reader
 * has to pair up. D2's markdown block terminates on a leading `|`, so the
 * entries are a bulleted list and never a table.
 *
 * `near: bottom-center` is the D2 constant for "under the whole diagram"; a
 * shape address would tie the panel to one box and leave it off screen on a
 * wide picture.
 *
 * @param findings - the problems found while deriving.
 * @returns the panel's D2 source, or `undefined` when there are none.
 */
function findingsPanel(findings: readonly Finding[]): string | undefined {
  if (findings.length === 0) return undefined
  const rendered = findings.map(finding => {
    const marker = finding.severity === 'error' ? '**error**' : 'warning'
    return `- ${marker} — ${finding.summary}`
  })
  return [
    'findings: |md',
    '  **Design findings**',
    '',
    ...rendered.map(line => `  ${line}`),
    '| { near: bottom-center }',
  ].join('\n')
}