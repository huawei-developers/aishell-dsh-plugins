/**
 * The chips' shared hover/focus sheet.
 *
 * This was a module-level install with an `id` guard — the shape that looks
 * right and fails on reload. The client loader sweeps only
 * `style[data-plugin]` tags on teardown, so an `id`-marked tag outlives its
 * module; the guard then finds it on the next materialization and returns
 * early, and the page keeps the *old* rule for the life of the tab. Editing
 * the CSS during development showed no change at all.
 *
 * The install now follows `dsh-client-ui-theme`'s `installThemeStyles`, the
 * framework's own answer for runtime-authored CSS: one `ctx.effect` per sheet,
 * a disposer that removes the tag, and the same `data-plugin` /
 * `data-plugin-css` markers the generated CSS modules carry.
 *
 * The document here is local and minimal (this package's other specs need no
 * DOM, and its manifests carry no DOM-test dependency): `createElement`,
 * `head.appendChild`, and a `querySelector` that understands the two selector
 * forms the code and these assertions use — `style[data-plugin-css]` and
 * `style[data-plugin="…"]`.
 */

import { describe, it, expect, afterEach, beforeEach } from 'vitest'
import { installChipStyles, CHIP_CLASS } from '../src/client/huawei-mark.ts'

/** One style tag as the assertions read it. */
interface StubTag {
  tagName: string
  textContent: string
  attributes: Map<string, string>
  parentElement: unknown
  remove: () => void
}

/** A document holding the tags installChipStyles appends. */
function makeDocument(): { document: Document, tags: StubTag[] } {
  const tags: StubTag[] = []
  const matches = (tag: StubTag, selector: string): boolean => {
    const attr = selector.match(/^style\[([a-zA-Z-]+)(?:="([^"]*)")?\]$/)
    if (attr === null) return false
    if (tag.tagName !== 'STYLE') return false
    const [, name, value] = attr
    if (value === undefined) return tag.attributes.has(name!)
    return tag.attributes.get(name!) === value
  }
  const document = {
    createElement: (tagName: string): StubTag => {
      const tag: StubTag = {
        tagName: tagName.toUpperCase(),
        textContent: '',
        attributes: new Map(),
        parentElement: null,
        remove: () => {
          const index = tags.indexOf(tag)
          if (index !== -1) tags.splice(index, 1)
          tag.parentElement = null
        },
      }
      // `tag.dataset.x = v` writes `data-x`, as the DOM does.
      Object.defineProperty(tag, 'dataset', {
        value: new Proxy({} as Record<string, string>, {
          set: (_t, key: string, v: string) => {
            tag.attributes.set(`data-${String(key).replace(/[A-Z]/g, c => `-${c.toLowerCase()}`)}`, v)
            return true
          },
          get: (_t, key: string) =>
            tag.attributes.get(`data-${String(key).replace(/[A-Z]/g, c => `-${c.toLowerCase()}`)}`),
        }),
      })
      return tag
    },
    head: {
      appendChild: (tag: StubTag): StubTag => {
        tags.push(tag)
        tag.parentElement = document.head
        return tag
      },
    },
    querySelector: (selector: string): StubTag | null => tags.find(tag => matches(tag, selector)) ?? null,
    querySelectorAll: (selector: string): StubTag[] => tags.filter(tag => matches(tag, selector)),
  }
  return { document: document as unknown as Document, tags }
}

/** A ctx stub exposing only what installChipStyles uses. */
function makeCtx(): {
  ctx: unknown
  /** Run every effect's disposer, as a fiber teardown would. */
  teardown: () => void
} {
  const disposers: Array<() => void> = []
  const ctx = {
    effect: (fn: () => unknown) => {
      const result = fn()
      if (typeof result === 'function') disposers.push(result as () => void)
      return () => {}
    },
  }
  return {
    ctx,
    teardown: () => { for (const dispose of disposers.splice(0)) dispose() },
  }
}

let originalDocument: unknown

beforeEach(() => {
  originalDocument = (globalThis as { document?: unknown }).document
})

afterEach(() => {
  if (originalDocument === undefined) delete (globalThis as { document?: unknown }).document
  else (globalThis as { document?: unknown }).document = originalDocument
})

/** Install the stub document as the global, as a browser would provide it. */
function useDocument(): { document: Document, tags: StubTag[] } {
  const made = makeDocument()
  ;(globalThis as { document?: unknown }).document = made.document
  return made
}

describe('installChipStyles', () => {
  it('mounts the sheet with both loader markers', () => {
    const { document, tags } = useDocument()
    const { ctx } = makeCtx()

    installChipStyles(ctx as never)

    expect(tags).toHaveLength(1)
    const tag = tags[0]!
    // The loader sweeps `style[data-plugin="<id>"]`; without this marker the
    // tag is unreachable on teardown, which is the bug this shape fixes.
    expect(tag.attributes.get('data-plugin')).toBe('@huaweidevtools/aishell-dsh-client-credentials')
    expect(tag.attributes.get('data-plugin-css')).toBeDefined()
    expect(tag.textContent).toContain(`.${CHIP_CLASS}:hover`)
    expect(tag.textContent).toContain(`.${CHIP_CLASS}:focus-visible`)
    expect(document.querySelector('style[data-plugin-css]')).not.toBeNull()
  })

  it('is owned by the fiber: the disposer removes the tag', () => {
    const { document } = useDocument()
    const { ctx, teardown } = makeCtx()

    installChipStyles(ctx as never)
    expect(document.querySelector('style[data-plugin-css]')).not.toBeNull()

    teardown()
    expect(document.querySelector('style[data-plugin-css]')).toBeNull()
  })

  it('re-installs after a teardown, leaving exactly one sheet', () => {
    // THE regression the old shape had: the `id`-guarded module-level install
    // left its tag in place, so a second install short-circuited and the page
    // kept rendering the stale rule. Here teardown genuinely clears the way.
    const { document } = useDocument()

    const first = makeCtx()
    installChipStyles(first.ctx as never)
    first.teardown()
    expect(document.querySelector('style[data-plugin-css]')).toBeNull()

    const second = makeCtx()
    installChipStyles(second.ctx as never)
    expect(document.querySelectorAll('style[data-plugin-css]')).toHaveLength(1)
    second.teardown()
  })

  it('is a no-op without a document', () => {
    // Imported by components that also load under Node (this spec
    // environment), so the guard must hold before any DOM is touched.
    delete (globalThis as { document?: unknown }).document
    const { ctx, teardown } = makeCtx()
    expect(() => installChipStyles(ctx as never)).not.toThrow()
    teardown()
  })
})
