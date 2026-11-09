/**
 * Drawing an account that already exists.
 *
 * ## What this module is given, and what it is not
 *
 * Its input is `InventoryTopology`: nodes carrying the raw `provider`/`type`
 * the inventory reported, and edges carrying the attribute that established
 * them. Nothing here has been translated into a design vocabulary first, which
 * is why nothing here needs a table of kinds — the picture can contain a
 * service this deployment has never seen.
 *
 * ## Colour
 *
 * A table of types would need a line per service and would be wrong the first
 * time an unfamiliar one appeared. Colouring by provider alone is not enough
 * either: a picture of one VPC and nine security groups then reads as ten of
 * the same thing.
 *
 * So the provider picks the hue and the type picks the lightness step inside it:
 * resources of one service read as a family, and different types inside it stay
 * apart. Both are D2's own theme classes, so the dark palette follows with no
 * JavaScript.
 *
 * The mapping is a hash rather than an assignment, for the same reason: a table
 * that assigned a hue per service would need a new line for every service, and
 * a service missing from it would draw in whatever the fallback happened to be.
 *
 * @module @huaweidevtools/aishell-dsh-deploy/d2-inventory
 */

import type { InventoryEdge, InventoryNode, InventoryTopology } from './existing-topology.ts'
import { d2Id, quote, renderD2, themePreamble } from './d2-engine.ts'
import type { RenderResult } from './d2-engine.ts'

/**
 * The D2 palette ramps, one hue each with three lightness steps.
 *
 * Four ramps rather than a per-provider table: `hash(provider) % 4` picks one,
 * so a provider not named anywhere still gets a stable, distinct colour.
 */
const PROVIDER_RAMPS: readonly (readonly string[])[] = [
  ['fill-B5, stroke-B3', 'fill-B6, stroke-B4', 'fill-B4, stroke-B2'],
  ['fill-AA4, stroke-AA2', 'fill-AA5, stroke-AA4', 'fill-AA3, stroke-AA2'],
  ['fill-AB5, stroke-AB4', 'fill-AB4, stroke-AB4', 'fill-AB6, stroke-AB5'],
  ['fill-N7, stroke-N5', 'fill-N6, stroke-N4', 'fill-N5, stroke-N3'],
]

/** The class an arrow into a resource carries: "traffic flows here". */
const CONNECTION_CLASS = 'stroke-AB3'

/**
 * How many top-level boxes go in one row of an inventory picture.
 *
 * Three. Measured on a live 30-resource account: one row (D2's arrangement for
 * unconnected roots) is 9.6:1, five columns is 5.8:1, four is 4.8:1 and three is
 * 3.4:1. Below three the picture grows tall rather than wide, and a wider grid
 * pushes the strip down a level instead of removing it.
 */
const GRID_COLUMNS = 3

/**
 * The class for one provider/type pair, stable across runs and pictures.
 *
 * @param provider - the service that reported the resource.
 * @param type - that service's own type name.
 * @returns a D2 theme class reference.
 */
export function inventoryClass(provider: string, type: string): string {
  const hash = (text: string): number => {
    let value = 0
    for (const character of text) value = (value * 31 + character.charCodeAt(0)) >>> 0
    return value
  }
  const ramp = PROVIDER_RAMPS[hash(provider) % PROVIDER_RAMPS.length]!
  return ramp[hash(type) % ramp.length]!
}

/**
 * Draw an inventory-derived topology.
 *
 * @param topology - the picture derived from the inventory.
 * @returns the D2 source and the SVG it renders to.
 */
export async function renderInventoryTopology(
  topology: InventoryTopology,
): Promise<RenderResult> {
  const source = inventoryToD2(topology)
  return { source, svg: await renderD2(source) }
}

/**
 * Generate the D2 source for an inventory-derived topology.
 *
 * @param topology - the picture.
 * @returns D2 source text.
 */
export function inventoryToD2(topology: InventoryTopology): string {
  const lines: string[] = themePreamble()

  // A grid, not a single column.
  //
  // Left alone, D2 lays every unconnected node out in one row, and for a real
  // account that is a strip: a live 30-resource inventory comes out 9.6:1 —
  // 9144×949 — which is unreadable inline at any sane width.
  //
  // `grid-columns` is D2's own layout control for this case: it wraps the roots
  // into rows of N. Applied at the root, it lays out the top-level boxes only —
  // children stay inside their parent, which is where the nesting already
  // places them.
  if (topology.roots.length > GRID_COLUMNS) {
    lines.push(`grid-columns: ${GRID_COLUMNS}`, '')
  }

  const write = (node: InventoryNode, depth: number): void => {
    const indent = '  '.repeat(depth)
    const label = node.facts.length === 0
      ? node.label
      : `${node.label}  ${node.facts.map(fact => fact.value).join(' · ')}`
    const style = `class: [${inventoryClass(node.provider, node.type)}]`
    if (node.children.length === 0) {
      lines.push(`${indent}${nodeId(node.id)}: ${quote(label)} { ${style} }`)
      return
    }
    lines.push(`${indent}${nodeId(node.id)}: ${quote(label)} {`)
    lines.push(`${indent}  ${style}`)
    for (const child of node.children) write(child, depth + 1)
    lines.push(`${indent}}`)
  }

  for (const root of topology.roots) write(root, 0)
  if (topology.roots.length > 0) lines.push('')

  for (const edge of drawnEdges(topology)) {
    lines.push(
      `${nodeId(edge.from)} -> ${nodeId(edge.to)}: ${quote(edge.attribute)}`
      + ` { class: [${CONNECTION_CLASS}] }`,
    )
  }

  return lines.join('\n')
}

/**
 * The relationships worth drawing as an arrow.
 *
 * Three kinds of association are dropped, each for a reason that shows up on a
 * real account rather than being a preference:
 *
 *   1. **Containment.** A parent/child edge is already said by the nesting, and
 *      an arrow beside it draws the same fact twice — the line leaves the box
 *      it never left.
 *   2. **The reverse of another edge.** The inventory reports both ends of a
 *      relationship: an EIP names its bandwidth and the bandwidth names the
 *      EIP, a server names its volumes and each volume names the server. Both
 *      are true, but one arrow per pair says as much and does not put two
 *      lines on top of each other. Measured on a live 49-resource account:
 *      40 associations, 32 distinct pairs.
 *   3. **A reference that points at an ancestor.** The VPC a resource sits in
 *      is visible from where the resource is drawn; a line from inside the
 *      container out to it adds no fact and crosses the container's border to
 *      say nothing. Five of those on the same account, all of them `vpc_id`.
 *
 * What is left is a genuine cross-container reference: a resource here naming
 * a resource there. Those are the ones a reader has to follow, so they are the
 * ones that get a line.
 *
 * @param topology - the derived picture.
 * @returns the edges to draw, deduplicated and without the ones nesting implies.
 */
export function drawnEdges(topology: InventoryTopology): readonly InventoryEdge[] {
  const parentOf = new Map(topology.nodes.map(node => [node.id, node.parent]))
  const ancestorsOf = new Map(topology.nodes.map(node => [node.id, node.ancestors]))

  const seenPairs = new Set<string>()
  const drawn: InventoryEdge[] = []
  for (const edge of topology.edges) {
    if (parentOf.get(edge.from) === edge.to) continue
    if ((ancestorsOf.get(edge.from) ?? []).includes(edge.to)) continue

    // One arrow per unordered pair. The pair is sorted so `a -> b` and `b -> a`
    // collide, and the first one seen keeps whichever attribute it carried —
    // the direction of the arrow is therefore whichever end the inventory
    // reported first, which is a fact about the data, not about the picture.
    const pair = [edge.from, edge.to].sort().join('\u0000')
    if (seenPairs.has(pair)) continue
    seenPairs.add(pair)
    drawn.push(edge)
  }
  return drawn
}

/**
 * The D2 identifier for a cloud id.
 *
 * The `r_` prefix is what keeps an id from colliding with D2's own reserved
 * words, and the base conversion handles every character D2 would otherwise
 * read as syntax.
 *
 * @param id - a cloud resource id.
 * @returns an identifier D2 accepts.
 */
function nodeId(id: string): string {
  return d2Id(`r_${id}`)
}