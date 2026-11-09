/**
 * The D2 renderer itself: source text in, SVG out.
 *
 * ## What this module owns, and what it does not
 *
 * It owns the mechanism — instantiating the WASM build, compiling, rendering,
 * and handing the linear memory back. It knows nothing about topology: the
 * source text it is given could draw anything.
 *
 * That separation is why there are two topology modules beside it
 * (`d2-design.ts` and `d2-inventory.ts`). They generate different source from
 * different inputs, and neither is a mode of the other; putting both in one file
 * made a module whose reader could not tell which rules applied to which
 * picture.
 *
 * ## Why D2 at all
 *
 * A network topology is a nested graph with edges, and every hand-rolled layout
 * for one has to solve two things badly: where a box goes, and where its edges
 * land. D2 solves both, and it is the format's own vocabulary — containers
 * nest, arrows connect, `near:` pins an annotation panel.
 *
 * The cost is real and worth stating: the WASM build is ~21 MB packaged, and
 * the compile step instantiates it once per process (~1.1 s cold, then ~70 ms
 * per diagram). It runs inside a worker thread that D2 owns, so the
 * instantiation does not block this process's event loop; {@link closeD2}
 * terminates that worker, which is the only way to hand the ~600 MB of WASM
 * linear memory back.
 *
 * ## What D2 does and does not carry
 *
 * It carries the PICTURE. It does not carry data: custom `vars` are discarded,
 * an attribute written as a child (`cidr: "10.0.0.0/16"`) becomes a visible
 * second box, and a mistyped attribute or an edge to an undefined node are
 * accepted silently. So nothing is ever read back out of D2 — a topology is
 * derived from its own source and D2 is only where it is drawn. That direction
 * matters: a generator is exact, a parser of pictures is not.
 *
 * @module @huaweidevtools/aishell-dsh-deploy/d2-engine
 */

import { D2 } from '@terrastruct/d2'

/**
 * The D2 themes, light and dark.
 *
 * Theme 5 rather than 0 for light. Theme 0 collapses its accent ramps into one
 * blue-grey: `B`, `AA` and `AB` all resolve to shades of `#EDF0FD`/`#F7F8FE`
 * there, so a diagram styled with three kinds of box draws three boxes in one
 * colour. Theme 5 keeps them apart — blue, violet, pink (measured against the
 * rendered palette, not the docs).
 *
 * 201 rather than 200 for dark, for the same reason and by the same measurement:
 * 200 collapses the same way (`B2` and `AA2` both `#CBA6f7`), 201 keeps a
 * distinguishable blue/violet/teal.
 *
 * Both ids must be given. With no `dark-theme-id` D2 emits NO dark palette at
 * all, and every class would resolve in light colours on a dark ground.
 */
export const LIGHT_THEME_ID = 5
export const DARK_THEME_ID = 201

/** One render in, one render out; the caller owns timing and disposal. */
export interface RenderResult {
  /** The D2 source that was rendered, so a reader can see what was drawn. */
  readonly source: string
  /** The SVG, with no XML declaration so it embeds directly in HTML. */
  readonly svg: string
}

/**
 * The `vars` block every generated diagram opens with.
 *
 * The theme ids are written into the diagram rather than passed to `render`, so
 * the generated source is the whole description of what was drawn — a reader
 * feeding it to the D2 CLI gets the same colours.
 *
 * @returns the opening lines of a D2 document.
 */
export function themePreamble(): string[] {
  return [
    'direction: down',
    '',
    'vars: {',
    '  d2-config: {',
    `    theme-id: ${LIGHT_THEME_ID}`,
    `    dark-theme-id: ${DARK_THEME_ID}`,
    '  }',
    '}',
    '',
  ]
}

/**
 * Compile D2 source and render it to an SVG.
 *
 * @param source - the D2 source text.
 * @returns the SVG, with no XML declaration.
 * @throws when the source does not compile. That is a defect in the generator
 *   rather than in the user's configuration — the generator produced the text —
 *   so the caller names the generated fragment in its message.
 */
export async function renderD2(source: string): Promise<string> {
  const d2 = new D2()
  try {
    const compiled = await d2.compile(source, { options: { layout: 'elk' } })
    const svg = await d2.render(compiled.diagram, {
      ...compiled.renderOptions,
      pad: 20,
      noXMLTag: true,
    })
    return withIntrinsicSize(svg)
  } finally {
    // The worker thread holds the WASM instance and its linear memory; without
    // this the process keeps ~600 MB for the lifetime of the agent session.
    await closeD2(d2)
  }
}

/**
 * Give the outer `<svg>` an intrinsic size.
 *
 * ## Why this is not cosmetic
 *
 * D2 emits the outer element with a `viewBox` and no `width`/`height`. In CSS,
 * an SVG with no intrinsic dimensions is a replaced element with no size, and
 * the browser falls back to 300×150 — then scales the whole `viewBox` into that
 * box. A picture of a real account is around 5000×1800, so the scale factor is
 * roughly 0.06 and a 16px label is drawn at about 1px: the diagram renders, and
 * is unreadable at any preview size.
 *
 * That is not a layout problem to tune — the file is correct, and it has no
 * size of its own. Declaring one gives the browser something to lay out at its
 * natural dimensions; whatever container shows it can then scale a legible
 * image down rather than a legible image already scaled to nothing.
 *
 * The values come from the viewBox, which is what D2 computed from the content,
 * so nothing is guessed. A viewBox D2 did not emit is left alone: a wrong size
 * would be worse than the default, and the caller's render would be reported
 * as broken for a reason that is not theirs.
 *
 * @param svg - the rendered SVG.
 * @returns the same SVG with `width` and `height` on the outer element.
 */
export function withIntrinsicSize(svg: string): string {
  const outer = /<svg\b[^>]*>/.exec(svg)
  if (outer === null) return svg
  const tag = outer[0]
  // Already sized: leave it, so this is safe to apply twice.
  if (/\swidth="/.test(tag) || /\sheight="/.test(tag)) return svg

  const viewBox = /\sviewBox="([^"]*)"/.exec(tag)
  const parts = viewBox?.[1]?.trim().split(/[\s,]+/) ?? []
  if (parts.length !== 4) return svg
  const width = Number(parts[2])
  const height = Number(parts[3])
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    return svg
  }

  const sized = tag.replace(
    /^<svg\b/,
    `<svg width="${width}" height="${height}"`,
  )
  return sized + svg.slice(outer.index + tag.length)
}

/**
 * Terminate the renderer's worker.
 *
 * `D2` exposes no disposal API, so the thread is terminated directly. The
 * failure is swallowed: a render that already produced its SVG must not be
 * reported as failed because the cleanup raced the worker's own shutdown.
 *
 * @param d2 - the renderer whose worker to stop.
 */
async function closeD2(d2: D2): Promise<void> {
  const worker = (d2 as unknown as { worker?: { terminate?: () => unknown } }).worker
  try {
    await worker?.terminate?.()
  } catch {
    // Nothing to report: the diagram is already rendered, and a worker that
    // refuses to stop is the process's exit problem, not this call's.
  }
}

/**
 * Quote a string for a D2 label.
 *
 * @param text - the label.
 * @returns the text inside double quotes, with its own quotes escaped.
 */
export function quote(text: string): string {
  return `"${text.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`
}

/**
 * The D2 identifier for an address or cloud id.
 *
 * A `.` in a D2 key means "member of the block before it", so an unreplaced one
 * nests the node inside a box named after the part before the dot — inventing a
 * container that does not exist. Every character D2 reserves is replaced by `_`
 * for the same reason.
 *
 * A collision is possible in principle (`a_b.c` and `a.b_c` both map to
 * `a_b_c`). It cannot occur inside one provider namespace, where the separator
 * between resource types and names is always the same `.`, but callers draw
 * from a map keyed by the original id, so a collision would drop an edge rather
 * than misplace it.
 *
 * @param address - a terraform `type.name` address or a cloud resource id.
 * @returns an identifier D2 accepts.
 */
export function d2Id(address: string): string {
  return address.replaceAll('.', '_').replaceAll(/[^A-Za-z0-9_]/g, '_')
}