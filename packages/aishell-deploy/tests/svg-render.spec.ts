/**
 * Drawing the placed boxes.
 *
 * Two properties matter and neither is visible in a screenshot review:
 *
 *   - **The file declares its size.** An SVG with only a `viewBox` is a replaced
 *     element with no intrinsic size, so a browser lays it out at 300×150 and
 *     scales the picture into that — a diagram that is correct and one pixel
 *     tall. This is what the intrinsic-size assertions exist for.
 *   - **A connector meets a border, not a centre.** A line that starts at a
 *     box's centre is drawn over the box; one that starts on the edge is a
 *     relationship between two boxes.
 */

import { describe, it, expect } from 'vitest'

import { borderPoint, escapeXml, hslToHex, renderDiagram, routePoints } from '../src/svg-render.ts'
import type { Diagram } from '../src/svg-render.ts'
import type { PlacedBox } from '../src/layout.ts'

/** A placed box, for fixtures. */
function box(
  id: string,
  x: number,
  y: number,
  width: number,
  height: number,
  children: PlacedBox[] = [],
  depth = 0,
): PlacedBox {
  return { id, label: id, x, y, width, height, depth, existing: false, provider: '', detail: [], figure: undefined, children }
}

/** A minimal diagram of two boxes and one edge. */
function diagram(overrides: Partial<Diagram> = {}): Diagram {
  const a = box('a', 40, 40, 120, 40)
  const b = box('b', 240, 240, 120, 40)
  return {
    width: 400,
    height: 320,
    boxes: [a, b],
    edges: [{ from: 'a', to: 'b', label: 'traffic', kind: 'traffic' }],
    roles: new Map([['a', 'resource'], ['b', 'resource']]),
    ...overrides,
  }
}

describe('escapeXml', () => {
  it('replaces the five XML metacharacters', () => {
    expect(escapeXml(`a & b < c > d " e ' f`))
      .toBe('a &amp; b &lt; c &gt; d &quot; e &apos; f')
  })

  it('leaves ordinary text alone', () => {
    expect(escapeXml('subnet-aishell-e2b 172.16.240.0/20'))
      .toBe('subnet-aishell-e2b 172.16.240.0/20')
  })
})

describe('borderPoint', () => {
  it('exits through the side facing the other box', () => {
    const left = box('l', 0, 0, 100, 100)
    const right = box('r', 300, 0, 100, 100)
    // The other box is directly to the right, so the exit is the right edge.
    expect(borderPoint(left, 350, 50)).toEqual({ x: 100, y: 50 })
    expect(borderPoint(right, 50, 50)).toEqual({ x: 300, y: 50 })
  })

  it('exits through the top or bottom when the boxes are stacked', () => {
    const top = box('t', 0, 0, 100, 100)
    const bottom = box('b', 0, 300, 100, 100)
    expect(borderPoint(top, 50, 350)).toEqual({ x: 50, y: 100 })
    expect(borderPoint(bottom, 50, 50)).toEqual({ x: 50, y: 300 })
  })

  it('is always on the box, never inside it', () => {
    const subject = box('s', 100, 100, 200, 80)
    const targets = [
      [500, 140], [0, 140], [200, 400], [200, -200], [500, 400], [0, -200],
    ] as const
    for (const [tx, ty] of targets) {
      const point = borderPoint(subject, tx, ty)
      const onEdge = point.x === subject.x || point.x === subject.x + subject.width
        || point.y === subject.y || point.y === subject.y + subject.height
      expect(onEdge, `${point.x},${point.y}`).toBe(true)
    }
  })
})

describe('routePoints', () => {
  it('starts and ends on the boxes it joins', () => {
    const from = box('a', 40, 40, 120, 40)
    const to = box('b', 240, 240, 120, 40)
    const points = routePoints(from, to)
    const first = points[0]!
    const last = points.at(-1)!
    const on = (b: PlacedBox, x: number, y: number): boolean => (
      x === b.x || x === b.x + b.width || y === b.y || y === b.y + b.height
    )
    expect(on(from, first.x, first.y)).toBe(true)
    expect(on(to, last.x, last.y)).toBe(true)
  })

  it('turns only at right angles', () => {
    // An orthogonal route is what keeps a connector inside the corridor the
    // layout left between boxes instead of cutting across them.
    const points = routePoints(box('a', 0, 0, 100, 40), box('b', 300, 200, 100, 40))
    for (let i = 1; i < points.length; i++) {
      const previous = points[i - 1]!
      const current = points[i]!
      const axisAligned = previous.x === current.x || previous.y === current.y
      expect(axisAligned, `segment ${i}`).toBe(true)
    }
  })

  it('produces at least two points', () => {
    expect(routePoints(box('a', 0, 0, 10, 10), box('b', 50, 0, 10, 10)).length)
      .toBeGreaterThanOrEqual(2)
  })
})

describe('renderDiagram', () => {
  it('declares width and height, not only a viewBox', () => {
    // Without these the browser lays the file out at 300×150: the picture is
    // correct and unreadable, which is the symptom that points at the content
    // rather than at the attribute that decides how large it is drawn.
    const svg = renderDiagram(diagram())
    expect(svg).toContain('width="400"')
    expect(svg).toContain('height="320"')
    expect(svg).toContain('viewBox="0 0 400 320"')
  })

  it('draws every box', () => {
    const d = diagram()
    const svg = renderDiagram(d)
    for (const subject of d.boxes) {
      expect(svg).toContain(`>${subject.label}</text>`)
    }
  })

  it('paints a container before its contents', () => {
    // The renderer relies on list order for the frame to land behind what it
    // holds. A child emitted first would be covered by its parent.
    const outer = box('outer', 0, 0, 200, 200, [], 0)
    const inner = box('inner', 20, 20, 100, 40, [], 1)
    const svg = renderDiagram(diagram({
      boxes: [outer, inner],
      edges: [],
      roles: new Map([['outer', 'container'], ['inner', 'resource']]),
    }))
    expect(svg.indexOf('>outer</text>')).toBeLessThan(svg.indexOf('>inner</text>'))
  })

  it('marks the two edge kinds apart', () => {
    // Colour alone does not survive a black-and-white print, and the difference
    // matters there: one is where requests go, the other is why they may.
    const traffic = renderDiagram(diagram({
      edges: [{ from: 'a', to: 'b', label: 'HTTPS:443', kind: 'traffic' }],
    }))
    const policy = renderDiagram(diagram({
      edges: [{ from: 'a', to: 'b', label: 'ingress tcp 5432', kind: 'policy' }],
    }))
    expect(traffic).toContain('arrowTraffic')
    expect(policy).toContain('arrowPolicy')
    expect(policy).toContain('stroke-dasharray')
    expect(traffic).not.toContain('stroke-dasharray')
  })

  it('skips an edge whose endpoint was not placed', () => {
    // Drawing it against a box the engine would invent presents a relationship
    // that may not exist.
    const svg = renderDiagram(diagram({
      edges: [{ from: 'a', to: 'missing', label: 'x', kind: 'traffic' }],
    }))
    expect(svg).not.toContain('"missing"')
    expect(svg).not.toContain('HTTPS')
  })

  it('escapes a label that contains markup', () => {
    // A resource name is whatever the account's owner typed. Unescaped, it ends
    // the element and the file stops being well-formed XML.
    const svg = renderDiagram(diagram({
      boxes: [{ ...box('x', 0, 0, 100, 40), label: '<script>&' }],
      edges: [],
      roles: new Map([['x', 'resource']]),
    }))
    expect(svg).not.toContain('<script>')
    expect(svg).toContain('&lt;script&gt;&amp;')
  })

  it('renders an empty diagram without failing', () => {
    const svg = renderDiagram(diagram({ boxes: [], edges: [], roles: new Map() }))
    expect(svg).toContain('<svg')
    expect(svg).toContain('</svg>')
  })
})
describe('colour — telling services and levels apart', () => {
  it('tints each service its own hue', () => {
    // A keyed table would need a line per service and be wrong the first time
    // an unfamiliar one appeared; a hash keeps every service distinct including
    // ones this build has never seen.
    const svg = renderDiagram(diagram({
      boxes: [
        { ...box('e', 0, 0, 100, 40), provider: 'ecs' },
        { ...box('v', 200, 0, 100, 40), provider: 'vpc' },
        { ...box('r', 400, 0, 100, 40), provider: 'rds' },
      ],
      edges: [],
      roles: new Map([['e', 'resource'], ['v', 'resource'], ['r', 'resource']]),
    }))
    // Only the box rects: the arrowhead markers carry their own fills, and
    // counting those too would make the number say nothing about the boxes.
    // Box rects carry x/y; the canvas background does not, and it is not a box.
    const fills = [...svg.matchAll(/<rect x="[^"]*"[^>]*fill="(#[0-9a-f]{6})"/g)]
      .map(match => match[1])
    expect(new Set(fills).size).toBe(3)
  })

  it('gives one service one hue whatever it is called', () => {
    // The hue is about the service, not the resource: two ECS instances are the
    // same colour so a reader can group them.
    const svg = renderDiagram(diagram({
      boxes: [
        { ...box('a', 0, 0, 100, 40), provider: 'ecs' },
        { ...box('b', 200, 0, 100, 40), provider: 'ecs' },
      ],
      edges: [],
      roles: new Map([['a', 'resource'], ['b', 'resource']]),
    }))
    const fills = [...svg.matchAll(/<rect x="[^"]*"[^>]*fill="(#[0-9a-f]{6})"/g)]
      .map(match => match[1])
    expect(new Set(fills).size).toBe(1)
  })

  it('keeps a tint readable rather than washing it out', () => {
    // At 96% lightness every hue landed within a few units of the others and a
    // rendered PNG showed #F9F1F5, #F1F4F9 and #F9F5F1 side by side — the same
    // colour to a reader.
    const svg = renderDiagram(diagram({
      boxes: [{ ...box('x', 0, 0, 100, 40), provider: 'vpc' }],
      edges: [],
      roles: new Map([['x', 'resource']]),
    }))
    // The tint has to stay away from white, where every hue reads the same.
    const fill = /<rect x="[^"]*"[^>]*fill="#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})"/.exec(svg)
    const [r, g, b] = [1, 2, 3].map(group => Number.parseInt(fill![group]!, 16))
    const mean = (r! + g! + b!) / 3
    expect(mean).toBeLessThan(240)
  })

  it('gives containers a colour per nesting level', () => {
    // Depth alone cannot say which thing a box is — a group and a server share a
    // level — so it only says how deep the nesting goes, which is what a reader
    // needs to see where one container ends.
    const outer = box('outer', 0, 0, 300, 300, [], 0)
    const inner = box('inner', 20, 20, 200, 200, [], 1)
    const svg = renderDiagram(diagram({
      boxes: [outer, inner],
      edges: [],
      roles: new Map([['outer', 'container'], ['inner', 'container']]),
    }))
    const fills = [...svg.matchAll(/fill="(#[0-9a-f]{6})"/g)].map(match => match[1])
    expect(fills[0]).not.toBe(fills[1])
  })
})

describe('colour — the emitted syntax', () => {
  it('never emits hsl(), which some renderers turn into black', () => {
    // librsvg does not parse the space-separated CSS Color 4 form and fills the
    // shape black without reporting anything — verified against a real render:
    // every resource box came out black. Channels are computed here instead, so
    // no CSS colour parser is in the path.
    const svg = renderDiagram(diagram({
      boxes: [
        { ...box('a', 0, 0, 100, 40), provider: 'ecs' },
        { ...box('b', 200, 0, 100, 40), provider: 'vpc' },
      ],
      edges: [],
      roles: new Map([['a', 'resource'], ['b', 'resource']]),
    }))
    expect(svg).not.toContain('hsl(')
    expect(svg).toMatch(/fill="#[0-9a-f]{6}"/)
  })

  it('converts HSL to the colour it names', () => {
    // The conversion is the only thing standing between the hue and a blank box,
    // so its known values are pinned rather than eyeballed.
    expect(hslToHex(0, 100, 50)).toBe('#ff0000')
    expect(hslToHex(120, 100, 50)).toBe('#00ff00')
    expect(hslToHex(240, 100, 50)).toBe('#0000ff')
    expect(hslToHex(0, 0, 100)).toBe('#ffffff')
    expect(hslToHex(0, 0, 0)).toBe('#000000')
  })
})
