/**
 * The mount point the suggestion strip renders into, inside the hero.
 *
 * ## Why a portal, and not CSS placement
 *
 * The strip is a `conversation.input.dock` entry, and that band renders BELOW
 * the hero workspace row in the composer stack. Measured on the live page
 * (1280×900, DSH 0.2.x):
 *
 *     hero (headline)              y=288  h=74
 *     hero workspace row           y=374  h=28
 *     conversation.input.dock      y=411  h=80
 *     the input card               y=491
 *
 * The product wants the cards directly under the headline, and the workspace
 * row sits between. A negative margin cannot cross it — the row would be
 * covered — and the row's own subtree is not reachable from the dock, since
 * the two are separate children of the composer stack.
 *
 * The hero, however, already renders an empty content div for exactly this
 * purpose. Its stack is: headline → (the "Powered by" label) → `_body`, where
 * `_body` is `flex-direction: column` and left empty by the official shell.
 * That is the hero's content area, and putting the cards there is using the
 * slot as intended rather than fighting the layout.
 *
 * ## How the mount is found
 *
 * By the hero's own class suffix, from the headline outward — `[class*="_body"]`
 * alone is ambiguous (the conversation root has a `_body` too, and the live
 * page has two). So the search starts at a `[class*="_headline"]`, steps to its
 * parent (the hero stack), and takes that stack's own `_body` child. The
 * headline is unique on the page and is what makes the walk unambiguous.
 *
 * Children are walked directly rather than with `:scope >`. The two are
 * equivalent here, and the direct walk keeps these helpers working against the
 * hand-rolled DOM stub the specs use (which has no selector engine) instead of
 * leaving the module's real logic untested.
 *
 * The classes are CSS-module hashes (`pXSMma_body`), hence the suffix match.
 * A base bump that renames them fails closed: {@link findHeroContent} returns
 * null, the portal renders nothing, and the arrows and cards simply do not
 * appear — the strip is never left in the wrong parent.
 *
 * @module @huaweidevtools/aishell-dsh-brand/client/hero-content
 */

/** The first direct child whose class contains `fragment`. */
function childWithClass(parent: Element, fragment: string): HTMLElement | null {
  for (const child of Array.from(parent.children)) {
    if (child.className.includes(fragment)) return child as HTMLElement
  }
  return null
}

/** The first direct child carrying `data-<name>`. */
function childWithData(parent: Element, attribute: string): HTMLElement | null {
  for (const child of Array.from(parent.children)) {
    if (child.hasAttribute(attribute)) return child as HTMLElement
  }
  return null
}

/** The child marker, so a disposer can find exactly the node it made. */
const MOUNT_ATTRIBUTE = 'data-aishell-suggestions-mount'

/**
 * The hero's content area, or `null` when the hero is not on screen.
 *
 * Returns null rather than throwing: a New Session that has not painted its
 * hero yet is a normal state (and the strip retries on the next frame), not an
 * error.
 */
export function findHeroContent(target: Document): HTMLElement | null {
  if (typeof target.querySelector !== 'function') return null
  const headline = target.querySelector<HTMLElement>('[class*="_headline"]')
  const stack = headline?.parentElement ?? null
  if (stack === null) return null
  return childWithClass(stack, '_body')
}

/**
 * A container for the strip inside the hero content area.
 *
 * The hero body is `display: block` and zero-height, so the strip cannot rely
 * on it for layout and must not inherit that block context. The wrapper is
 * created here rather than rendered by React into the official div, because
 * React does not own that node — it owns only what the portal puts inside.
 */
export function ensureHeroMount(content: HTMLElement): HTMLElement {
  const existing = childWithData(content, MOUNT_ATTRIBUTE)
  if (existing !== null) return existing
  const mount = content.ownerDocument.createElement('div')
  mount.setAttribute(MOUNT_ATTRIBUTE, '')
  content.appendChild(mount)
  return mount
}

/**
 * Remove the mount this module created, if it is still there.
 *
 * Only the mount is removed — never the host div, which belongs to the shell
 * and is reused on the next New Session.
 */
export function removeHeroMount(content: HTMLElement): void {
  childWithData(content, MOUNT_ATTRIBUTE)?.remove()
}