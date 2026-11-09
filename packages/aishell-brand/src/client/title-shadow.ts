/**
 * Runtime window-title shadowing for the branded distribution.
 *
 * The official product title is baked into the dsh tree at build time
 * (`DSH_CLIENT_TITLE` → "DeepSeek Harness" in both the served
 * dsh-web-frontend dist index.html and the ui-layout DocumentTitle
 * component), and that tree is covered by the desktop-runtime digest —
 * the asar shell-layer swap cannot reach it. The plugin side therefore
 * shadows the title at runtime: this module intercepts every
 * `document.title` write in the renderer and rewrites the product name
 * to "AI Shell" in flight. The Electron main process never calls
 * setTitle on the main window, so the window title follows
 * document.title and this single seam covers both.
 *
 * Shadowing is a default, not a force (plan §2.2): install() and the
 * disposer it returns are symmetric, so disabling the plugin restores
 * the official title behavior exactly.
 *
 * @module @huaweidevtools/aishell-dsh-brand/client
 */

/** The official product title, baked into the digest-protected dsh tree. */
const OFFICIAL_TITLE = 'DeepSeek Harness'

/** The branded product title that shadows it. */
const BRANDED_TITLE = 'AI Shell'

/**
 * Rewrite the product name inside a title write.
 * Anything else in the value (the session-title prefix ui-layout adds)
 * passes through untouched, and a value without the product name is
 * returned as-is — the shadow never invents content.
 */
export function rebrandTitle(value: string): string {
  return value.split(OFFICIAL_TITLE).join(BRANDED_TITLE)
}

/** The disposer restores the official title behavior; a no-op install returns this. */
export type TitleShadowDisposer = () => void

/**
 * Find the `title` property descriptor on the prototype chain.
 *
 * `document.title` is a WebIDL accessor on Document.prototype — the
 * instance itself has no own property to describe, so the descriptor
 * must be located by walking up the chain.
 */
function findTitleDescriptor(target: object): PropertyDescriptor | undefined {
  let proto: object | null = target
  while (proto !== null) {
    const desc = Object.getOwnPropertyDescriptor(proto, 'title')
    if (desc !== undefined) return desc
    proto = Object.getPrototypeOf(proto)
  }
  return undefined
}

/**
 * Install the title shadow on the document.
 *
 * Defines an own `title` property on the instance (shadowing the
 * prototype accessor) whose setter rewrites each write, then rewrites
 * the current title once so the page's initial <title> from the served
 * dist is covered too. Returns the disposer: it removes the own
 * property (the prototype accessor takes over again) and rewrites the
 * live value back to its official form, so an unload leaves the shell
 * exactly as it was found.
 */
export function installTitleShadow(target: Document): TitleShadowDisposer {
  const original = findTitleDescriptor(target)
  if (original === undefined || original.configurable !== true || typeof original.set !== 'function') {
    return () => {}
  }

  const nativeSet = original.set
  const shadow: PropertyDescriptor = {
    configurable: true,
    enumerable: original.enumerable ?? false,
    ...(original.get !== undefined ? { get: original.get } : {}),
    set(value: string): void {
      nativeSet.call(this, typeof value === 'string' ? rebrandTitle(value) : value)
    },
  }
  Object.defineProperty(target, 'title', shadow)

  // Cover the initial <title> from the served dist immediately; later
  // writes (ui-layout's DocumentTitle runs on every session/panel
  // change) go through the setter above. Re-assign the current value
  // through the shadow setter so the native store sees a real write.
  const initial = target.title
  target.title = initial

  return () => {
    delete (target as { title?: string }).title
    target.title = target.title.split(BRANDED_TITLE).join(OFFICIAL_TITLE)
  }
}
