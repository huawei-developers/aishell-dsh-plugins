/**
 * Home whale-decoration removal for the branded distribution.
 *
 * ui-brand-official mounts a decorative whale on the New-Session page: a canvas
 * covering the conversation frame, painted from a spritesheet and played for one
 * ripple when a reader clicks blank home space. It carries no product name, but
 * it is DeepSeek's own artwork drawn in that product's voice — the alternating
 * code fill spells out harness API samples — so a distributed shell does not
 * keep it.
 *
 * There is no slot that can withdraw it. The plugin registers into
 * `conversation.hero.frame`, an `hoc` slot, and an `hoc` outlet composes every
 * layer: priority orders them, and none can decline another. The registration is
 * also unconditional — unlike the sidebar brand slots it is not gated on
 * `DSH_CLIENT_BUILD_PROFILE` — so no build-profile lever reaches it either. The
 * decoration is therefore shadowed by CSS, anchored on the `data-home-whale`
 * attribute ui-brand-official writes on its own canvas.
 *
 * `display: none` rather than `visibility: hidden` or an opacity of zero. The
 * renderer lays its spritesheet out from the measured box and stops when that
 * box is empty (`drawable()` requires a positive width and height), so a hidden
 * element does no work at all rather than painting frames nobody can see.
 *
 * The selector carries `:root` for specificity rather than for reach: the owner
 * sets `display: block` through a CSS-module class, which ties with a lone
 * attribute selector, and a tie is resolved by whichever stylesheet the client
 * loader happens to add last. One extra compound selector settles it without
 * depending on plugin order.
 *
 * Shadowing is a default, not a force: install() and the disposer it returns are
 * symmetric, so disabling the plugin restores the official decoration exactly.
 *
 * @module @huaweidevtools/aishell-dsh-brand/client/home-whale-shadow
 */

/** The disposer removes the patch style element; a no-op install returns this. */
export type HomeWhaleShadowDisposer = () => void

/** Marker attribute the patch style element carries (exposed for the spec). */
export const HOME_WHALE_PATCH_MARKER = 'data-aishell-home-whale'

/**
 * The attribute ui-brand-official writes on the decoration's canvas
 * (`PixelWhale.tsx`). A literal the owner sets itself, not a CSS-module hash, so
 * this selector does not follow a base bump.
 *
 * `:root` is prefixed for specificity — see the module note. Without it the rule
 * only wins when it happens to be added after the owner's stylesheet.
 */
const WHALE_CANVAS_SELECTOR = ':root [data-home-whale]'

/** The patch CSS. */
export const HOME_WHALE_PATCH_CSS = `${WHALE_CANVAS_SELECTOR} {\n  display: none;\n}`

/**
 * Install the home-whale shadow on a document.
 *
 * Injects the patch CSS once (guarded by the marker attribute, so a second
 * install reuses the element) and returns the disposer that removes it.
 *
 * @param target - the document to patch.
 * @returns the disposer.
 */
export function installHomeWhaleShadow(target: Document): HomeWhaleShadowDisposer {
  if (typeof target.querySelector !== 'function') return () => {}
  const existing = target.querySelector(`style[${HOME_WHALE_PATCH_MARKER}]`)
  if (existing !== null) return () => { existing.remove() }
  const tag = target.createElement('style')
  tag.setAttribute(HOME_WHALE_PATCH_MARKER, '')
  tag.textContent = HOME_WHALE_PATCH_CSS
  target.head.appendChild(tag)
  return () => { tag.remove() }
}