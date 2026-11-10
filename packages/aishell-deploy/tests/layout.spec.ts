/**
 * Placing boxes inside boxes.
 *
 * The properties under test are the ones a diagram is read for, and each of
 * them fails silently if it is wrong — the picture still renders, it just lies:
 *
 *   - a child is inside its parent (or the nesting means nothing);
 *   - no two boxes overlap (or one hides another);
 *   - the canvas is not a strip (or it cannot be read);
 *   - two runs of the same tree agree (or two diagrams cannot be compared).
 */

import { describe, it, expect } from 'vitest'

import { labelWithFigure, layoutTree } from '../src/layout.ts'
import type { LayoutNode, PlacedBox } from '../src/layout.ts'

/** A node with children, for building fixtures compactly. */
function node(id: string, label: string, children: LayoutNode[] = []): LayoutNode {
  return { id, label, children }
}

/** Whether one box entirely contains another. */
function contains(outer: PlacedBox, inner: PlacedBox): boolean {
  return inner.x >= outer.x
    && inner.y >= outer.y
    && inner.x + inner.width <= outer.x + outer.width
    && inner.y + inner.height <= outer.y + outer.height
}

/** Whether two boxes overlap at all. */
function overlaps(a: PlacedBox, b: PlacedBox): boolean {
  return a.x < b.x + b.width
    && b.x < a.x + a.width
    && a.y < b.y + b.height
    && b.y < a.y + a.height
}


describe('layoutTree', () => {
  it('puts every child inside its parent', () => {
    // This is what nesting MEANS on the page. A child outside its parent's box
    // reads as unrelated, and the frame around the parent then says nothing.
    const layout = layoutTree([
      node('region', 'cn-north-4', [
        node('vpc', 'VPC', [
          node('subnet', 'subnet', [node('server', 'server')]),
        ]),
      ]),
    ])

    for (const box of layout.boxes) {
      for (const child of box.children) {
        expect(contains(box, child), `${child.label} inside ${box.label}`).toBe(true)
      }
    }
  })

  it('leaves no sibling overlapping another', () => {
    const layout = layoutTree([
      node('region', 'region', [
        node('a', 'alpha alpha alpha'),
        node('b', 'bravo'),
        node('c', 'charlie charlie'),
        node('d', 'delta'),
      ]),
    ])

    const siblings = layout.boxes.find(box => box.id === 'region')!.children
    for (let i = 0; i < siblings.length; i++) {
      for (let j = i + 1; j < siblings.length; j++) {
        expect(overlaps(siblings[i]!, siblings[j]!), `${i} vs ${j}`).toBe(false)
      }
    }
  })

  it('grows a container to fit its contents', () => {
    // A wide label forces a wide box, and the container must follow — otherwise
    // the child spills out and the nesting is a drawing error.
    const narrow = layoutTree([node('r', 'r', [node('a', 'a')])])
    const wide = layoutTree([node('r', 'r', [node('a', 'a much longer label here')])])
    expect(wide.boxes[0]!.width).toBeGreaterThan(narrow.boxes[0]!.width)
  })

  it('packs siblings toward a square rather than a long row', () => {
    // Four identical boxes in one row is a strip; two rows of two is a block.
    // The aspect is what the packing rule is for.
    const layout = layoutTree([
      node('r', 'region', [
        node('a', 'alpha'), node('b', 'bravo'), node('c', 'charlie'), node('d', 'delta'),
      ]),
    ])
    const box = layout.boxes.find(entry => entry.id === 'r')!
    expect(box.width / box.height).toBeLessThan(3)
  })

  it('keeps the canvas from becoming a strip', () => {
    // Several top-level regions: stacked in one column would be a ribbon, laid
    // out in one row a band. The measured result has to be neither extreme.
    const layout = layoutTree([
      node('a', 'region a', [node('a1', 'one')]),
      node('b', 'region b', [node('b1', 'two')]),
      node('c', 'region c', [node('c1', 'three')]),
    ])
    const ratio = layout.width / layout.height
    expect(ratio).toBeGreaterThan(0.3)
    expect(ratio).toBeLessThan(6)
  })

  it('is deterministic', () => {
    // Two pictures of the same account must be comparable. A layout that varied
    // between runs could not be diffed, and a reviewer could not say "this is
    // what changed".
    const build = (): LayoutNode[] => [
      node('r', 'region', [
        node('a', 'alpha', [node('a1', 'one'), node('a2', 'two')]),
        node('b', 'bravo'),
      ]),
    ]
    expect(layoutTree(build())).toEqual(layoutTree(build()))
  })

  it('handles an empty tree', () => {
    const layout = layoutTree([])
    expect(layout.boxes).toHaveLength(0)
    expect(layout.width).toBeGreaterThanOrEqual(0)
    expect(layout.height).toBeGreaterThanOrEqual(0)
  })

  it('handles a single leaf', () => {
    const layout = layoutTree([node('only', 'a box')])
    expect(layout.boxes).toHaveLength(1)
    expect(layout.boxes[0]!.depth).toBe(0)
  })

  it('records depth, so the renderer can style by level', () => {
    const layout = layoutTree([
      node('r', 'region', [node('v', 'vpc', [node('s', 'subnet')])]),
    ])
    const depths = new Map(layout.boxes.map(box => [box.id, box.depth]))
    expect(depths.get('r')).toBe(0)
    expect(depths.get('v')).toBe(1)
    expect(depths.get('s')).toBe(2)
  })

  it('lists parents before their children', () => {
    // The renderer paints in list order so a container's frame lands behind its
    // contents without clipping. A child listed first would be painted over.
    const layout = layoutTree([node('r', 'region', [node('v', 'vpc', [node('s', 'subnet')])])])
    const order = layout.boxes.map(box => box.id)
    expect(order.indexOf('r')).toBeLessThan(order.indexOf('v'))
    expect(order.indexOf('v')).toBeLessThan(order.indexOf('s'))
  })

  it('flattens every box exactly once', () => {
    // A box drawn twice is the same picture with extra paint; a box left out is
    // a resource the reader cannot see.
    const layout = layoutTree([
      node('r', 'region', [
        node('a', 'alpha', [node('a1', 'one')]),
        node('b', 'bravo'),
      ]),
    ])
    const ids = layout.boxes.map(box => box.id)
    expect(new Set(ids).size).toBe(ids.length)
    expect(ids.sort()).toEqual(['a', 'a1', 'b', 'r'])
  })

  it('honours the margin it is given', () => {
    const layout = layoutTree([node('r', 'region')], 100)
    expect(layout.boxes[0]!.x).toBeGreaterThanOrEqual(100)
    expect(layout.boxes[0]!.y).toBeGreaterThanOrEqual(100)
  })

  it('never places a box at a negative coordinate', () => {
    // A negative origin puts part of the picture outside the canvas, where no
    // amount of scrolling reaches it.
    for (const box of layoutTree([node('r', 'r', [node('c', 'child')])]).boxes) {
      expect(box.x, box.label).toBeGreaterThanOrEqual(0)
      expect(box.y, box.label).toBeGreaterThanOrEqual(0)
    }
  })
})
describe('layoutTree — box metrics', () => {
  it('gives siblings a common width', () => {
    // A row sized to each label comes out ragged, and a reader takes a wider
    // box for a more important one. Equalising inside one parent keeps the
    // comparison local to boxes that sit side by side.
    const layout = layoutTree([
      node('r', 'container', [
        node('short', 'a'),
        node('long', 'a considerably longer label'),
        node('mid', 'abc'),
      ]),
    ])
    const widths = layout.boxes.find(box => box.id === 'r')!.children.map(child => child.width)
    expect(new Set(widths).size).toBe(1)
  })

  it('leaves a single child at its own width', () => {
    // Nothing to equalise with, and padding it to a phantom sibling would be a
    // width nobody chose.
    const layout = layoutTree([node('r', 'container', [node('only', 'x')])])
    const only = layout.boxes.find(box => box.id === 'only')!
    const bare = layoutTree([node('only', 'x')]).boxes[0]!
    expect(only.width).toBe(bare.width)
  })

  it('does not equalise heights', () => {
    // A tall container beside a short leaf is a real difference; padding every
    // leaf to the height of a VPC would be a lie about what the box holds.
    const layout = layoutTree([
      node('r', 'container', [
        node('tall', 'container', [node('inner', 'x')]),
        node('flat', 'y'),
      ]),
    ])
    const kids = layout.boxes.find(box => box.id === 'r')!.children
    expect(kids[0]!.height).toBeGreaterThan(kids[1]!.height)
  })

  it('leaves room for a container label above its contents', () => {
    // The title band has to clear the text it holds: a band sized to the type
    // exactly reads as pressed against the frame.
    const layout = layoutTree([
      node('r', 'container', [node('child', 'x')]),
    ])
    const parent = layout.boxes.find(box => box.id === 'r')!
    const child = layout.boxes.find(box => box.id === 'child')!
    const gap = child.y - parent.y
    // A 13px label with its baseline in the band needs more than one line's
    // worth of clearance.
    expect(gap).toBeGreaterThan(26)
  })
})

describe('layoutTree — roots and detail lines', () => {
  it('puts every root in one row', () => {
    // The roots are the top of the picture and a reader compares them left to
    // right. Wrapping them puts two above two with nothing saying they are
    // peers, and the eye reads that as a hierarchy that does not exist.
    const layout = layoutTree([
      node('a', 'region a', [node('a1', 'x')]),
      node('b', 'region b', [node('b1', 'y')]),
      node('c', 'region c', [node('c1', 'z')]),
    ])
    const roots = layout.boxes.filter(box => box.depth === 0)
    expect(new Set(roots.map(box => box.y)).size).toBe(1)
  })

  it('grows a leaf to hold its detail lines', () => {
    // The lines are drawn inside the box, so a box that did not grow would draw
    // them outside it.
    const bare = layoutTree([{ id: 'a', label: 'a', children: [] }]).boxes[0]!
    const withDetail = layoutTree([
      { id: 'a', label: 'a', detail: ['in  tcp 5432 <- sg-db'], children: [] },
    ]).boxes[0]!
    expect(withDetail.height).toBeGreaterThan(bare.height)
  })

  it('widens a leaf to hold a long detail line', () => {
    const short = layoutTree([
      { id: 'a', label: 'a', detail: ['in tcp 80'], children: [] },
    ]).boxes[0]!
    const long = layoutTree([
      { id: 'a', label: 'a', detail: ['in  tcp 5432-5433 <- sg-aishell-cce-turbo-pod'], children: [] },
    ]).boxes[0]!
    expect(long.width).toBeGreaterThan(short.width)
  })

  it('grows a container to hold its detail lines', () => {
    // A container can carry rules too: what a security group guards may itself
    // hold things.
    const bare = layoutTree([node('r', 'container', [node('c', 'x')])]).boxes[0]!
    const withDetail = layoutTree([
      { id: 'r', label: 'container', detail: ['in tcp 80 <- 10.0.0.0/8'], children: [node('c', 'x')] },
    ]).boxes[0]!
    expect(withDetail.height).toBeGreaterThan(bare.height)
  })
})

describe('layoutTree — a container that carries rules', () => {
  it('starts its children below the detail lines, not on top of them', () => {
    // The band's label sits at the top and each rule under it. Sizing the band
    // without those lines put the first row of children where the text was, and
    // the rules were drawn over the box below — a security group's text covering
    // the resource it guards.
    const layout = layoutTree([{
      id: 'ecs',
      label: 'ECS ecs-test',
      detail: ['in  tcp 80 <- 10.0.0.1/32', 'in  tcp 443 <- 10.0.0.1/32'],
      children: [{ id: 'disk', label: 'disk', children: [] }],
    }])
    const ecs = layout.boxes.find(box => box.id === 'ecs')!
    const disk = layout.boxes.find(box => box.id === 'disk')!

    // The label is at +18 and a detail line every 17px after it, so the second
    // line's baseline is around +52. The child has to start below that.
    expect(disk.y - ecs.y).toBeGreaterThan(52)
  })

  it('grows the box by the same amount it moves the children', () => {
    // Otherwise the last row of children would run past the container's own
    // bottom edge, and the frame would not enclose what it holds.
    const build = (detail: string[]): ReturnType<typeof layoutTree> => layoutTree([{
      id: 'r', label: 'container', detail, children: [{ id: 'c', label: 'child', children: [] }],
    }])
    const bare = build([])
    const two = build(['in  tcp 80 <- 10.0.0.1', 'in  tcp 443 <- 10.0.0.1'])
    const bareChild = bare.boxes.find(box => box.id === 'c')!
    const twoChild = two.boxes.find(box => box.id === 'c')!
    const grown = two.boxes.find(box => box.id === 'r')!.height
      - bare.boxes.find(box => box.id === 'r')!.height
    expect(twoChild.y - bareChild.y).toBe(grown)
  })
})

describe('layoutTree — a figure', () => {
  it('rides the figure on the label rather than taking a line of its own', () => {
    // `sg [3]` is one line of identity. A separate band would make the box two
    // blocks a reader has to associate, and the count is a property of the name.
    const bare = layoutTree([{ id: 'g', label: 'sg', detail: ['in tcp 80'], children: [] }]).boxes[0]!
    const withFigure = layoutTree([
      { id: 'g', label: 'sg', detail: ['in tcp 80'], figure: '3', children: [] },
    ]).boxes[0]!
    expect(withFigure.height).toBe(bare.height)
  })

  it('appends the count to the label', () => {
    expect(labelWithFigure('sg', '3')).toBe('sg [3]')
    expect(labelWithFigure('sg', '0')).toBe('sg [0]')
  })

  it('leaves a label alone when there is no count', () => {
    // Not `sg []` and not `sg [undefined]`: a box with nothing to count keeps
    // the name it had.
    expect(labelWithFigure('sg', undefined)).toBe('sg')
  })


})
