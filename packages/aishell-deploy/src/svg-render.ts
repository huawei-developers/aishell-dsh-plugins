/**
 * Drawing a laid-out diagram as SVG.
 *
 * ## Why this does not go through D2
 *
 * D2 renders a graph: it takes the nodes and the edges and decides where each
 * goes. That is the wrong division of labour for a picture whose structure is
 * already known — the nesting IS the layout — because the engine lays sibling
 * containers out in a row whatever they contain, and no amount of input
 * adjustment changes that (measured at 4–6:1 on a real account).
 *
 * Here the placement is already decided by `layout.ts`, and this module does the
 * one thing left: turn rectangles and connectors into markup. That also makes
 * the theme cheap — two class blocks and CSS `prefers-color-scheme`, rather than
 * a WASM build.
 *
 * ## What it draws
 *
 *   - A container's box first, then its label in the title band, then its
 *     children. Painting in that order is what puts the frame behind the
 *     contents without any clip path.
 *   - Edges last, so a connector is never hidden under a box it passes near.
 *     Endpoints sit on the box border, computed from the centre-to-centre
 *     direction, so a line leaves one box and arrives at another rather than
 *     crossing them.
 *
 * @module @huaweidevtools/aishell-dsh-deploy/svg-render
 */

import { labelWithFigure } from './layout.ts'
import type { PlacedBox } from './layout.ts'

/** How a box is drawn, by the role it plays in the picture. */
export type BoxRole =
  /** A region, VPC, or subnet: something that holds other things. */
  | 'container'
  /** A resource that sits at the bottom of the tree. */
  | 'resource'

/**
 * The hues a container is drawn in, by its nesting depth.
 *
 * Depth alone cannot say WHICH thing a box is — a security group and an ECS sit
 * at the same level — so this is not an identity, only a way to read the nesting
 * at a glance. Two colours alternate down the levels, which is enough to see
 * where one container ends and the next begins without turning the picture into
 * a palette.
 *
 * A resource's own service is a different question, answered by `serviceHue`.
 */
const CONTAINER_DEPTH_FILL = ['#e8eef7', '#dde7f5', '#d2dff2'] as const
const CONTAINER_DEPTH_STROKE = ['#9aa8bd', '#8294af', '#6b80a0'] as const

/**
 * Convert HSL to a `#rrggbb` string.
 *
 * The conversion is done here rather than left to the renderer, because several
 * SVG rasterisers do not parse the space-separated CSS Color 4 syntax and fall
 * back to black without reporting anything.
 *
 * @param hue - 0–359.
 * @param saturation - 0–100.
 * @param lightness - 0–100.
 * @returns the colour as hex.
 */
export function hslToHex(hue: number, saturation: number, lightness: number): string {
  const s = saturation / 100
  const l = lightness / 100
  const c = (1 - Math.abs(2 * l - 1)) * s
  const x = c * (1 - Math.abs(((hue / 60) % 2) - 1))
  const m = l - c / 2
  const [r, g, b] = hue < 60 ? [c, x, 0]
    : hue < 120 ? [x, c, 0]
      : hue < 180 ? [0, c, x]
        : hue < 240 ? [0, x, c]
          : hue < 300 ? [x, 0, c]
            : [c, 0, x]
  const channel = (value: number): string => (
    Math.round((value + m) * 255).toString(16).padStart(2, '0')
  )
  return `#${channel(r)}${channel(g)}${channel(b)}`
}

/**
 * The hue a service's boxes are tinted with.
 *
 * Keyed by the provider the inventory reports, which is a stable identity: every
 * `ecs` resource is the same service whatever it is called. A hash rather than a
 * table, for the reason the connector colours use one — a table would need a
 * line per service and would be wrong the first time an unfamiliar one appeared.
 *
 * @param provider - the service that reported the resource.
 * @returns a hue in degrees, 0–359.
 */
export function serviceHue(provider: string): number {
  let value = 0
  for (const character of provider) value = (value * 31 + character.charCodeAt(0)) >>> 0
  return value % 360
}

/**
 * The fill and stroke for one box.
 *
 * @param role - whether the box holds other boxes.
 * @param provider - the service that reported it, for a resource.
 * @param depth - the nesting level, for a container.
 * @returns the two colours.
 */
function boxColours(
  role: BoxRole,
  provider: string,
  depth: number,
): { readonly fill: string, readonly stroke: string } {
  if (role === 'container') {
    const level = Math.min(depth, CONTAINER_DEPTH_FILL.length - 1)
    return { fill: CONTAINER_DEPTH_FILL[level]!, stroke: CONTAINER_DEPTH_STROKE[level]! }
  }
  // 88% lightness. At 96% every hue lands within a few units of the others and
  // the tint says nothing — measured on a rendered PNG, the fills were #F9F1F5,
  // #F1F4F9 and #F9F5F1, the same colour to a reader. Lower keeps the hue
  // legible against a white canvas while still reading as a tint rather than a
  // block of colour.
  //
  // Written as hex, not as `hsl(...)`. The space-separated CSS Color 4 form is
  // legal in a stylesheet and NOT understood by every SVG renderer: librsvg
  // cannot parse `hsl(117 45% 88%)` and fills the shape black. Computing the
  // channels here removes the CSS parser from the path entirely.
  const hue = serviceHue(provider)
  return {
    fill: hslToHex(hue, 45, 88),
    stroke: hslToHex(hue, 40, 55),
  }
}

/** One connector between two placed boxes. */
export interface BoxEdge {
  readonly from: string
  readonly to: string
  /** The words on the line, already translated from a property name. */
  readonly label: string
  /**
   * What the connector asserts.
   *
   * `traffic` is a flow — packets travel this way, and the label says on what
   * port. `policy` is a rule — one group admits another, and nothing moves
   * along it. They are drawn differently because a reader acts on them
   * differently: one is where a request goes, the other is why it is allowed.
   */
  readonly kind: 'traffic' | 'policy'
}

/** Everything the renderer needs. */
export interface Diagram {
  readonly width: number
  readonly height: number
  readonly boxes: readonly PlacedBox[]
  readonly edges: readonly BoxEdge[]
  /** The role of each box, by id. A box with no entry is drawn as a resource. */
  readonly roles: ReadonlyMap<string, BoxRole>
}

/** Colours and metrics, kept in one place so both themes stay in step. */
const TOKENS = {
  ink: '#1b1f24',
  muted: '#57606a',
  canvas: '#ffffff',
  containerFill: '#eef4ff',
  containerStroke: '#9cc0f5',
  resourceFill: '#f7f8fa',
  resourceStroke: '#c7ccd4',
  /** A flow of traffic: warm, because it is what the reader is following. */
  traffic: '#0969da',
  /** A policy rule: cool and dashed, because nothing moves along it. */
  policy: '#8250df',
  labelBackground: '#ffffff',
} as const

/**
 * Escape text for XML content and attributes.
 *
 * @param text - the string to escape.
 * @returns the same text with the five XML metacharacters replaced.
 */
export function escapeXml(text: string): string {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;')
}

/**
 * Where a connector meets a box's border, on the side facing the other box.
 *
 * The connector is drawn as an orthogonal path, so it leaves through a
 * horizontal edge when the boxes are stacked and through a vertical edge when
 * they are side by side. Picking the side from the relative position is what
 * keeps the first and last segment perpendicular to the border it touches —
 * a line meeting a box at an angle reads as passing behind it.
 *
 * @param box - the box whose border point is wanted.
 * @param towardX - the other box's centre, x.
 * @param towardY - the other box's centre, y.
 * @returns the point on the box's border.
 */
export function borderPoint(
  box: PlacedBox,
  towardX: number,
  towardY: number,
): { readonly x: number, readonly y: number } {
  const cx = box.x + box.width / 2
  const cy = box.y + box.height / 2
  const dx = towardX - cx
  const dy = towardY - cy

  // Compare the normalised distances: which axis the other centre is further
  // along decides the edge. Dividing by the half-extent makes a wide box count
  // properly, so a box one pixel taller than wide does not flip to a side exit.
  const horizontal = Math.abs(dx) / (box.width / 2 || 1)
  const vertical = Math.abs(dy) / (box.height / 2 || 1)

  if (horizontal > vertical) {
    return { x: dx > 0 ? box.x + box.width : box.x, y: cy }
  }
  return { x: cx, y: dy > 0 ? box.y + box.height : box.y }
}

/**
 * Draw one box: its rectangle, then its label.
 *
 * A container's label sits in its title band, at the top, left-aligned — the
 * convention every architecture diagram uses, and what makes a nested box read
 * as "this region contains the things below it" rather than as a floating card.
 *
 * A leaf's label is centred in its box.
 *
 * @param box - the placed box.
 * @param role - how to draw it.
 * @returns the markup for the box itself, not its children.
 */
function drawBox(box: PlacedBox, role: BoxRole): string {
  const isContainer = role === 'container'
  const { fill, stroke } = boxColours(role, box.provider, box.depth)
  const radius = isContainer ? 6 : 4
  const weight = isContainer ? 600 : 400

  // A reused resource is dashed. The distinction is the first thing a reviewer
  // checks — "am I about to duplicate what we have" — so it has to survive a
  // greyscale view of the picture, which a colour difference would not.
  const dash = box.existing ? ' stroke-dasharray="7 5"' : ''
  const shape = `<rect x="${box.x}" y="${box.y}" width="${box.width}" height="${box.height}" `
    + `rx="${radius}" fill="${fill}" stroke="${stroke}" stroke-width="1.5"${dash}/>`

  if (isContainer) {
    // Label in the title band, left-aligned to the padding the children use,
    // and any detail lines under it inside the same band — a container can carry
    // rules too, because what a security group guards may itself hold things.
    const textX = box.x + 16
    let textY = box.y + 18
    let markup = shape + `<text x="${textX}" y="${textY}" font-size="13" `
      + `font-weight="${weight}" fill="${TOKENS.ink}">${escapeXml(box.label)}</text>`
    for (const line of box.detail) {
      textY += DETAIL_LINE
      markup += `<text x="${textX}" y="${textY}" font-size="10" `
        + `fill="${TOKENS.muted}" font-family="ui-monospace, SFMono-Regular, Menlo, monospace">`
        + `${escapeXml(line)}</text>`
    }
    return markup
  }

  // A leaf: the label centred, the rule lines LEFT-aligned under it, and a
  // figure centred below those.
  //
  // The alignment carries meaning. A label is a name and reads centred; a rule
  // list is a column and reads down its left edge — centring it makes the eye
  // hunt for where each line starts. The figure is a single number, so it is
  // centred again, and larger, so it is taken for a count rather than for
  // another rule.
  const centreX = box.x + box.width / 2
  const lines = box.detail.length
  const blockHeight = lines * DETAIL_LINE
  // The whole block — label, rules, figure — is centred vertically in the box.
  const labelY = box.y + box.height / 2 + 4 - blockHeight / 2

  let markup = shape + `<text x="${centreX}" y="${labelY}" font-size="12" `
    + `text-anchor="middle" font-weight="${weight}" fill="${TOKENS.ink}">`
    + `${escapeXml(labelWithFigure(box.label, box.figure))}</text>`

  const leftX = box.x + PADDING
  for (const [index, line] of box.detail.entries()) {
    const y = labelY + DETAIL_LINE * (index + 1)
    markup += `<text x="${leftX}" y="${y}" font-size="10" `
      + `fill="${TOKENS.muted}" font-family="ui-monospace, SFMono-Regular, Menlo, monospace">`
      + `${escapeXml(line)}</text>`
  }

  return markup
}

/** The vertical distance between detail lines, matching the layout's own. */
const DETAIL_LINE = 17

/** The padding a leaf's left-aligned rules start from. */
const PADDING = 16

/**
 * The points an orthogonal connector turns at.
 *
 * ## Why orthogonal and not straight
 *
 * A straight line between two boxes passes over whatever lies between them —
 * and in a packed box tree, that is the sibling boxes. Measured on a real
 * account: every one of twenty-seven connectors crossed a box that was not one
 * of its endpoints. An orthogonal path with one bend in the gap between rows
 * stays in the empty corridor the layout already leaves there.
 *
 * The path leaves along the axis its border point faces, turns once in the
 * corridor, and arrives along the same axis. Two segments per bend, so the
 * route is always three or four points and never doubles back.
 *
 * @param from - the source box.
 * @param to - the target box.
 * @returns the polyline's points, source first.
 */
export function routePoints(
  from: PlacedBox,
  to: PlacedBox,
): readonly { readonly x: number, readonly y: number }[] {
  const fromCx = from.x + from.width / 2
  const fromCy = from.y + from.height / 2
  const toCx = to.x + to.width / 2
  const toCy = to.y + to.height / 2

  const start = borderPoint(from, toCx, toCy)
  const end = borderPoint(to, fromCx, fromCy)

  // Which edge each box was exited through: a horizontal exit means the
  // connector is travelling vertically and the corridor is horizontal.
  const startVertical = start.x === fromCx
  const endVertical = end.x === toCx

  if (startVertical && endVertical) {
    // Both exit top/bottom: one horizontal step at the midpoint between them,
    // which is the row gap.
    const midY = (start.y + end.y) / 2
    return [start, { x: start.x, y: midY }, { x: end.x, y: midY }, end]
  }
  if (!startVertical && !endVertical) {
    // Both exit left/right: one vertical step at the midpoint column.
    const midX = (start.x + end.x) / 2
    return [start, { x: midX, y: start.y }, { x: midX, y: end.y }, end]
  }
  // Mixed: an L through the corner the two exits meet at.
  return [start, { x: end.x, y: start.y }, end]
}

/**
 * Draw one connector as an orthogonal path, with its label on the route.
 *
 * The two kinds are told apart by weight and dash: a traffic flow is solid and
 * heavier — it is where requests go — while a policy rule is dashed, because
 * nothing travels along it. Colour alone would not survive a black-and-white
 * print, and the difference matters enough to be readable there.
 *
 * @param edge - the connector.
 * @param from - the box it leaves.
 * @param to - the box it arrives at.
 * @returns the markup.
 */
function drawEdge(edge: BoxEdge, from: PlacedBox, to: PlacedBox): string {
  const points = routePoints(from, to)
  const path = points.map((point, index) => `${index === 0 ? 'M' : 'L'} ${point.x} ${point.y}`).join(' ')

  const traffic = edge.kind === 'traffic'
  const stroke = traffic ? TOKENS.traffic : TOKENS.policy
  const width = traffic ? 2 : 1.2
  const dash = traffic ? '' : ` stroke-dasharray="5 4"`
  const marker = traffic ? 'arrowTraffic' : 'arrowPolicy'

  const line = `<path d="${path}" fill="none" stroke="${stroke}" stroke-width="${width}"${dash} `
    + `marker-end="url(#${marker})"/>`

  if (edge.label === '') return line

  // The label goes on the middle segment, where the route is long enough to
  // read it. With only two points there is no middle segment, so the midpoint
  // of the whole route is used.
  const middle = points.length >= 4
    ? { x: (points[1]!.x + points[2]!.x) / 2, y: (points[1]!.y + points[2]!.y) / 2 }
    : { x: (points[0]!.x + points.at(-1)!.x) / 2, y: (points[0]!.y + points.at(-1)!.y) / 2 }

  // The label needs a backing rectangle or it is unreadable over a line that
  // passes behind it. Width is estimated the same way box widths are.
  const width_ = edge.label.length * 7 + 8
  const plaque = `<rect x="${middle.x - width_ / 2}" y="${middle.y - 9}" width="${width_}" `
    + `height="18" rx="3" fill="${TOKENS.labelBackground}" fill-opacity="0.92"/>`
  const text = `<text x="${middle.x}" y="${middle.y + 4}" font-size="11" text-anchor="middle" `
    + `fill="${traffic ? TOKENS.ink : TOKENS.muted}" font-weight="${traffic ? 600 : 400}">`
    + `${escapeXml(edge.label)}</text>`

  return line + plaque + text
}

/**
 * Render the diagram.
 *
 * The SVG declares `width` and `height` from the layout, not only a `viewBox`.
 * Without them a browser treats the file as a replaced element with no size and
 * lays it out at the CSS default of 300×150, scaling everything into that box —
 * which draws a readable diagram at about one pixel.
 *
 * @param diagram - the placed boxes and connectors.
 * @returns the SVG document, with no XML declaration so it embeds in HTML.
 */
export function renderDiagram(diagram: Diagram): string {
  const byId = new Map(diagram.boxes.map(box => [box.id, box]))
  const parts: string[] = []

  parts.push(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${diagram.width}" `
    + `height="${diagram.height}" viewBox="0 0 ${diagram.width} ${diagram.height}" `
    + `font-family="ui-sans-serif, system-ui, -apple-system, 'Segoe UI', sans-serif">`,
  )

  // The arrowheads are defined once and referenced by every connector. Two of
  // them, because a traffic arrow and a policy arrow are coloured apart.
  parts.push(
    '<defs>'
    + `<marker id="arrowTraffic" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" `
    + 'markerHeight="7" orient="auto-start-reverse">'
    + `<path d="M 0 0 L 10 5 L 0 10 z" fill="${TOKENS.traffic}"/></marker>`
    + `<marker id="arrowPolicy" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" `
    + 'markerHeight="6" orient="auto-start-reverse">'
    + `<path d="M 0 0 L 10 5 L 0 10 z" fill="${TOKENS.policy}"/></marker>`
    + '</defs>',
  )

  parts.push(`<rect width="${diagram.width}" height="${diagram.height}" fill="${TOKENS.canvas}"/>`)

  // Parents before children, so a container's frame is painted behind the
  // boxes it holds. The flattening in `layoutTree` already yields that order.
  for (const box of diagram.boxes) {
    parts.push(drawBox(box, diagram.roles.get(box.id) ?? 'resource'))
  }

  // Connectors last: an edge that passes near a box stays visible over it.
  for (const edge of diagram.edges) {
    const from = byId.get(edge.from)
    const to = byId.get(edge.to)
    if (from === undefined || to === undefined) continue
    parts.push(drawEdge(edge, from, to))
  }

  parts.push('</svg>')
  return parts.join('')
}