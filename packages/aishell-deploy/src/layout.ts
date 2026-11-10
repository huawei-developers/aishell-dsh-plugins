/**
 * Laying out an architecture diagram: boxes inside boxes.
 *
 * ## What this computes, and why it is not delegated
 *
 * A network diagram is a set of nested regions — a region holds VPCs, a VPC
 * holds subnets, a subnet holds resources — and the nesting IS the picture. A
 * general graph layout engine treats nesting as one expression among many: D2's
 * ELK and dagre backends both lay sibling containers out in a row regardless of
 * what is inside them, measured at 4–6:1 on a real account, which is a strip no
 * preview can show.
 *
 * The layout here follows from the structure instead of searching for it:
 *
 *   1. **Size, bottom up.** A leaf is its label plus padding. A container is
 *      the packing of its children plus padding and a title band. Nothing is
 *      positioned until every box knows its own size.
 *   2. **Place, top down.** A container gives each child a slot inside itself,
 *      and the child does the same for its own children. A child is inside its
 *      parent by construction, not by a rule that has to be checked afterwards.
 *   3. **Pack siblings toward square.** Given a list of child boxes, the number
 *      of columns is the one whose packed block is least elongated. A row of
 *      four wide boxes is a strip; two rows of two is a block.
 *
 * Every step is arithmetic on the box tree. There is no iteration, no
 * force-directed relaxation, and no randomness, so two runs of the same account
 * produce the same picture — which is what makes a diagram comparable.
 *
 * ## What it does not do
 *
 * It does not route edges. An edge's endpoints are box borders; drawing the
 * connector between them is the renderer's work, and it is kept apart from
 * placement so a change to one does not silently move the other.
 *
 * @module @huaweidevtools/aishell-dsh-deploy/layout
 */

/** One node of the tree to lay out. */
export interface LayoutNode {
  /** Stable identity, used to key edges against the placed boxes. */
  readonly id: string
  /** The text drawn on the box. Its length is what decides the box's width. */
  readonly label: string
  /**
   * Whether this box marks something that already existed.
   *
   * A design reuses resources it does not create, and a reviewer checks that
   * distinction first — "am I about to duplicate what we have". It travels with
   * the node rather than being looked up later, because only the caller knows
   * what its own ids mean.
   */
  readonly existing?: boolean
  /**
   * The service that reported this resource, for its tint.
   *
   * A stable identity: every `ecs` resource shares it however it is named. The
   * layout does not read it — only the renderer does — but it has to travel on
   * the node, because a placed box has no other link back to what it came from.
   */
  readonly provider?: string
  /**
   * Lines drawn under the label, left-aligned inside the box.
   *
   * A security group's rules belong to the group's own box, and they are detail
   * rather than identity: the name leads, these follow in a smaller face. Left
   * alignment is what makes them scannable — a column of rules read down the
   * left edge, the way a list is read.
   */
  readonly detail?: readonly string[]
  /**
   * A count appended to the label as `[n]`.
   *
   * For a security group it is how many resources use it, which is what
   * separates a live group from a leftover. It rides on the label rather than
   * occupying a band of its own: the name is the identity and the count is a
   * property of it, so `sg-postgresql [1]` reads as one thing.
   */
  readonly figure?: string
  /** What this box contains. */
  readonly children: readonly LayoutNode[]
}

/** A node's measured extent, before anything is positioned. */
interface Measured {
  readonly node: LayoutNode
  readonly width: number
  readonly height: number
  /** How many children share a row. */
  readonly columns: number
  readonly children: readonly Measured[]
}

/** A node with its final position. */
export interface PlacedBox {
  readonly id: string
  readonly label: string
  /** The top-left corner, in canvas coordinates. */
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
  /** The nesting depth; 0 for the outermost box. */
  readonly depth: number
  /** Whether this box marks something that already existed. */
  readonly existing: boolean
  /** The service that reported it, for the renderer's tint. */
  readonly provider: string
  /** Lines under the label, left-aligned inside this box. */
  readonly detail: readonly string[]
  /** A count shown centred under the detail lines. */
  readonly figure: string | undefined
  readonly children: readonly PlacedBox[]
}

/**
 * Horizontal space one character of a label takes.
 *
 * Measured against the font the diagram is drawn with: the renderer emits
 * `font-size: 16` with a sans-serif face, whose average advance is a little
 * over half an em. 9.6 is 0.6em, which is slightly generous — a box that is a
 * few pixels too wide reads as padding, and one that is too narrow truncates a
 * name.
 */
const CHAR_WIDTH = 9.6

/** Line height for a label at that size. */
const LINE_HEIGHT = 22

/** Line height for a detail line, which is drawn a size smaller. */
const DETAIL_LINE_HEIGHT = 17

/**
 * The text a box carries, with its count in brackets.
 *
 * `sg-postgresql [1]` rather than a separate figure: the count qualifies the
 * name, and putting it there keeps the box one line of identity instead of two
 * blocks a reader has to associate.
 *
 * @param label - the box's own label.
 * @param figure - the count, when there is one.
 * @returns the label with the count appended.
 */
export function labelWithFigure(label: string, figure: string | undefined): string {
  return figure === undefined ? label : `${label} [${figure}]`
}

/**
 * The height of a container's title band, including its detail lines.
 *
 * A container's own label sits at the top of the band and each detail line
 * under it, so the band has to be tall enough for both — plus the gap that
 * keeps the last line clear of the first row of children.
 *
 * `measure` sizes the box with this and `place` positions the children with it.
 * Those two must be the same number: a band sized for the label alone puts the
 * first row of children where the detail lines are drawn, and the lines land on
 * top of the child boxes.
 *
 * @param detail - the container's detail lines.
 * @returns the band height in pixels.
 */
function bandHeight(detail: readonly string[]): number {
  return detail.length === 0
    ? TITLE_BAND
    : TITLE_BAND + detail.length * DETAIL_LINE_HEIGHT + SIBLING_GAP / 2
}

/**
 * The width the widest detail line needs.
 *
 * @param detail - the lines under a container's label.
 * @returns the width in pixels, 0 when there are none.
 */
function textWidthOf(detail: readonly string[]): number {
  return detail.length === 0 ? 0 : Math.max(...detail.map(line => textWidth(line)))
}

/** Space between a container's border and its contents. */
const PADDING = 16

/** Space between sibling boxes. */
const SIBLING_GAP = 20

/**
 * The band at a container's top that holds its own label.
 *
 * 34, not the 26 that would fit a 13px line exactly: the label's baseline sits
 * 24 below the top edge, so text occupies roughly 18–30 and leaves 4px above
 * and 4px below. A band sized to the type exactly reads as pressed against the
 * frame, which is the thing this margin exists to prevent.
 */
const TITLE_BAND = 34

/** The narrowest a leaf box is allowed to be, so a short name is not a sliver. */
const MIN_LEAF_WIDTH = 120

/**
 * The width a label needs.
 *
 * @param label - the text on the box.
 * @returns its width in pixels.
 */
function textWidth(label: string): number {
  return label.length * CHAR_WIDTH
}

/**
 * The extent of a set of boxes packed into a given number of columns.
 *
 * @param sizes - the child extents.
 * @param columns - how many share a row.
 * @returns the packed width and height.
 */
function pack(
  sizes: readonly { readonly width: number, readonly height: number }[],
  columns: number,
): { readonly width: number, readonly height: number } {
  const rows = Math.ceil(sizes.length / columns)
  let width = 0
  let height = 0
  for (let row = 0; row < rows; row++) {
    const slice = sizes.slice(row * columns, (row + 1) * columns)
    width = Math.max(
      width,
      slice.reduce((sum, size) => sum + size.width, 0) + SIBLING_GAP * (slice.length - 1),
    )
    height += Math.max(...slice.map(size => size.height)) + (row < rows - 1 ? SIBLING_GAP : 0)
  }
  return { width, height }
}

/**
 * The column count that packs a set of boxes into the least elongated block.
 *
 * The measure is logarithmic, so a block twice as wide as it is tall scores the
 * same as one twice as tall as it is wide. A linear measure would call a wide
 * strip "close enough" whenever the target were small, which is the failure
 * this whole module exists to avoid.
 *
 * @param sizes - the child extents.
 * @returns the best column count, at least 1.
 */
function squarestColumns(
  sizes: readonly { readonly width: number, readonly height: number }[],
): number {
  let best = 1
  let bestError = Infinity
  // Beyond four the block is always taller than wide for these box shapes, so
  // the candidates past that could not win; the bound also keeps a container
  // with many children from being computed quadratically.
  const limit = Math.min(sizes.length, 4)
  for (let columns = 1; columns <= limit; columns++) {
    const packed = pack(sizes, columns)
    const error = Math.abs(Math.log(packed.width / packed.height))
    if (error < bestError) {
      bestError = error
      best = columns
    }
  }
  return best
}

/**
 * Measure a tree, bottom up.
 *
 * @param node - the node to measure.
 * @returns its extent and its children's, all positioned at the origin.
 */
function measure(node: LayoutNode): Measured {
  if (node.children.length === 0) {
    const detail = node.detail ?? []
    // The count is drawn inside the label, so it is measured with it.
    const label = labelWithFigure(node.label, node.figure)
    const widest = Math.max(
      textWidth(label),
      ...detail.map(line => textWidth(line)),
    )
    return {
      node,
      width: Math.max(widest + PADDING * 2, MIN_LEAF_WIDTH),
      height: LINE_HEIGHT + PADDING + detail.length * DETAIL_LINE_HEIGHT,
      columns: 1,
      children: [],
    }
  }
  // Siblings share a width. A row of boxes sized to their own labels comes out
  // ragged — an `ecs-test` beside an `aishell-turbo-ac9s.16xlarge.4-64c256g`
  // differs by more than three times — and a reader takes that difference for a
  // difference in importance. Equalising inside one parent keeps the comparison
  // local: boxes that sit side by side are the ones compared.
  const children = equalWidth(node.children.map(child => measure(child)))
  const columns = squarestColumns(children)
  const packed = pack(children, columns)
  // A container's detail lines live in its title band, so the band grows with
  // them — otherwise they are drawn over the first row of children.
  const detail = node.detail ?? []
  return {
    node,
    width: Math.max(packed.width, textWidthOf(detail)) + PADDING * 2,
    height: packed.height + bandHeight(detail) + PADDING,
    columns,
    children,
  }
}

/**
 * Give every sibling the width of the widest one.
 *
 * The width is applied to each child's OWN width, so a container among them
 * keeps room for its own contents; only the excess is added, never taken away.
 * Heights are left alone — a tall container beside a short leaf is a real
 * difference, and equalising it would pad every leaf to the size of a VPC.
 *
 * @param siblings - the measured children of one parent.
 * @returns the same children, widened to a common width.
 */
function equalWidth(siblings: readonly Measured[]): Measured[] {
  if (siblings.length < 2) return [...siblings]
  const widest = Math.max(...siblings.map(child => child.width))
  return siblings.map(child => (child.width === widest
    ? child
    : { ...child, width: widest }))
}

/**
 * Position a measured tree, top down.
 *
 * @param measured - the tree to place.
 * @param x - the left edge to place it at.
 * @param y - the top edge to place it at.
 * @param depth - the nesting depth, for the caller's styling.
 * @returns the placed boxes.
 */
function place(measured: Measured, x: number, y: number, depth: number): PlacedBox[] {
  const self: PlacedBox = {
    id: measured.node.id,
    label: measured.node.label,
    x,
    y,
    width: measured.width,
    height: measured.height,
    depth,
    existing: measured.node.existing === true,
    provider: measured.node.provider ?? '',
    detail: measured.node.detail ?? [],
    figure: measured.node.figure,
    // Children are filled in below; the array is built once so the object can
    // stay readonly to its consumers.
    children: [],
  }

  if (measured.children.length === 0) return [self]

  // Direct children and the flattened list are kept apart: the tree needs the
  // first, the renderer needs the second, and a result that confuses them
  // draws everything twice.
  const direct: PlacedBox[] = []
  const descendants: PlacedBox[] = []
  const rows = Math.ceil(measured.children.length / measured.columns)
  // The same band `measure` used, so the two cannot disagree: the child row
  // starts below every detail line, with the gap the band reserves for it.
  let cursorY = y + bandHeight(measured.node.detail ?? [])
  for (let row = 0; row < rows; row++) {
    const slice = measured.children.slice(row * measured.columns, (row + 1) * measured.columns)
    const rowWidth = slice.reduce((sum, child) => sum + child.width, 0)
      + SIBLING_GAP * (slice.length - 1)
    // Centred within the parent, so a short last row does not hang left.
    let cursorX = x + PADDING + (measured.width - PADDING * 2 - rowWidth) / 2
    for (const child of slice) {
      const [self_, ...rest] = place(child, cursorX, cursorY, depth + 1)
      direct.push(self_!)
      descendants.push(self_!, ...rest)
      cursorX += child.width + SIBLING_GAP
    }
    cursorY += Math.max(...slice.map(child => child.height)) + SIBLING_GAP
  }

  return [{ ...self, children: direct }, ...descendants]
}


/** A laid-out diagram: every box, flattened, plus the canvas extent. */
export interface Layout {
  /** Every box, parents before their children. */
  readonly boxes: readonly PlacedBox[]
  /** Only the outermost boxes, whose union is the canvas. */
  readonly roots: readonly PlacedBox[]
  /** The space the drawing needs, before any outer margin. */
  readonly width: number
  readonly height: number
}

/**
 * Lay out a tree of nested boxes.
 *
 * ## How the roots are arranged
 *
 * The roots are the same layer of the picture — a VPC, a band of shared
 * services — so they are packed beside each other rather than stacked. Which
 * The roots go in ONE row, however narrow the result. They are the top of the
 * picture — regions, usually — and a reader compares them left to right: which
 * region holds the VPC, which holds only a default group. Wrapping them onto
 * several rows puts two regions above two others with nothing saying they are
 * peers, and the eye reads that as a hierarchy that does not exist.
 *
 * Everything below a root is packed by the square rule, because there the
 * alternatives really are equivalent and the aspect decides.
 *
 * @param roots - the outermost boxes.
 * @param margin - space left around the whole drawing.
 * @returns the placed boxes and the canvas extent.
 */
export function layoutTree(
  roots: readonly LayoutNode[],
  margin = 40,
): Layout {
  const measured = roots.map(root => measure(root))

  const columns = measured.length
  const packed = pack(measured, columns)

  const placed: PlacedBox[] = []
  const rows = Math.ceil(measured.length / columns)
  let cursorY = margin
  for (let row = 0; row < rows; row++) {
    const slice = measured.slice(row * columns, (row + 1) * columns)
    const rowWidth = slice.reduce((sum, box) => sum + box.width, 0)
      + SIBLING_GAP * (slice.length - 1)
    // Centred, so a short last row does not hang left.
    let cursorX = margin + (packed.width - rowWidth) / 2
    for (const box of slice) {
      placed.push(...place(box, cursorX, cursorY, 0))
      cursorX += box.width + SIBLING_GAP
    }
    cursorY += Math.max(...slice.map(box => box.height)) + SIBLING_GAP
  }

  return {
    boxes: placed,
    roots: placed.filter(box => box.depth === 0),
    width: packed.width + margin * 2,
    height: cursorY - SIBLING_GAP + margin,
  }
}