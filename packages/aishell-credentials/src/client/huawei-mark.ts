/**
 * The Huawei mark and its brand colour, shared by both credential chips.
 *
 * Extracted so the composer chip and the hero chip cannot drift apart: they
 * report the same thing, and a colour or path change in one must not leave the
 * other behind.
 *
 * @module @huaweidevtools/aishell-dsh-client-credentials/client/huawei-mark
 */

import type { Context as ClientContext } from '@deepseek-ai/cordis'

/** Huawei logo path (from simple-icons/huawei), drawn in a 24×24 viewBox. */
export const HUAWEI_LOGO_PATH =
  'M3.67 6.14S1.82 7.91 1.72 9.78v.35c.08 1.51 1.22 2.4 1.22 2.4 1.83 1.79 6.26 4.04 7.3 4.55 0 0 .06.03.1-.01l.02-.04v-.04C7.52 10.8 3.67 6.14 3.67 6.14zM9.65 18.6c-.02-.08-.1-.08-.1-.08l-7.38.26c.8 1.43 2.15 2.53 3.56 2.2.96-.25 3.16-1.78 3.88-2.3.06-.05.04-.09.04-.09zm.08-.78C6.49 15.63.21 12.28.21 12.28c-.15.46-.2.9-.21 1.3v.07c0 1.07.4 1.82.4 1.82.8 1.69 2.34 2.2 2.34 2.2.7.3 1.4.31 1.4.31.12.02 4.4 0 5.54 0 .05 0 .08-.05.08-.05v-.06c0-.03-.03-.05-.03-.05zM9.06 3.19a3.42 3.42 0 00-2.57 3.15v.41c.03.6.16 1.05.16 1.05.66 2.9 3.86 7.65 4.55 8.65.05.05.1.03.1.03a.1.1 0 00.06-.1c1.06-10.6-1.11-13.42-1.11-13.42-.32.02-1.19.23-1.19.23zm8.299 2.27s-.49-1.8-2.44-2.28c0 0-.57-.14-1.17-.22 0 0-2.18 2.81-1.12 13.43.01.07.06.08.06.08.07.03.1-.03.1-.03.72-1.03 3.9-5.76 4.55-8.64 0 0 .36-1.4.02-2.34zm-2.92 13.07s-.07 0-.09.05c0 0-.01.07.03.1.7.51 2.85 2 3.88 2.3 0 0 .16.05.43.06h.14c.69-.02 1.9-.37 3-2.26l-7.4-.25zm7.83-8.41c.14-2.06-1.94-3.97-1.94-3.98 0 0-3.85 4.66-6.67 10.8 0 0-.03.08.02.13l.04.01h.06c1.06-.53 5.46-2.77 7.28-4.54 0 0 1.15-.93 1.21-2.42zm1.52 2.14s-6.28 3.37-9.52 5.55c0 0-.05.04-.03.11 0 0 .03.06.07.06 1.16 0 5.56 0 5.67-.02 0 0 .57-.02 1.27-.29 0 0 1.56-.5 2.37-2.27 0 0 .73-1.45.17-3.14z'

/**
 * Huawei brand red, rgb(207, 10, 44).
 *
 * A literal rather than a theme token: the theme's alias set carries no brand
 * or danger colour (checked — no `danger`/`error`/`critical` alias exists), so
 * there is nothing to reference and the value does not follow light/dark. It
 * is the brand mark's own colour, so it is meant to stay fixed.
 */
export const HUAWEI_RED = 'rgb(207, 10, 44)'

/**
 * Class carried by the clickable account-name control on both chips.
 *
 * A class rather than inline styles because `:hover` and `:focus-visible`
 * cannot be expressed inline, and the two chips must look identical on both.
 */
export const CHIP_CLASS = 'aishell-account-hint'

/**
 * Plugin id stamped on the style tag, and the same marker the build-time CSS
 * modules carry (`shared/tsdown.client.ts` sets `dataset.plugin` + a
 * `dataset.pluginCss` dedupe key). The loader's `removeOwnedStyles` sweeps
 * `style[data-plugin="<id>"]` on module teardown, so a tag written here is
 * reachable by the same mechanism as the generated ones.
 */
const PLUGIN_ID = '@huaweidevtools/aishell-dsh-client-credentials'

/** Dedupe key for the one sheet this module owns. */
const CHIP_STYLE_KEY = `${PLUGIN_ID}/chip-hover`

/**
 * Mount the chips' hover/focus rule for the owning plugin's lifetime.
 *
 * The shape follows `dsh-client-ui-theme`'s `installThemeStyles`, which is the
 * framework's own answer for runtime-authored CSS: one `ctx.effect` per sheet,
 * a disposer that removes the tag, and the `data-plugin` markers so
 * `removeOwnedStyles` can also reach it. The disposer is what makes a reload
 * pick up an edited rule — the fiber tears down, the tag goes, and the next
 * materialization writes the new text.
 *
 * A module-level install guarded by an id cannot do that: the tag outlives the
 * module because the loader sweeps only `data-plugin` tags, so the guard finds
 * it on the next materialization and returns, and the page keeps the rule from
 * before the edit for its whole life.
 *
 * Call once from `apply()`, not from the components: the rule is shared by
 * both chips (they carry the same `CHIP_CLASS`), so one sheet serves them and
 * two installers would fight over the same dedupe key.
 *
 * @param ctx - the browser-half plugin context whose effect owns the tag.
 */
export function installChipStyles(ctx: ClientContext): void {
  if (typeof document === 'undefined') return
  ctx.effect(() => {
    const tag = document.createElement('style')
    tag.dataset.plugin = PLUGIN_ID
    tag.dataset.pluginCss = CHIP_STYLE_KEY
    tag.textContent =
      `.${CHIP_CLASS}:hover{background:var(--dsw-alias-interactive-bg-hover)}` +
      `.${CHIP_CLASS}:focus-visible{outline:2px solid var(--dsw-alias-label-primary);outline-offset:-2px}`
    document.head.appendChild(tag)
    return () => { tag.remove() }
  }, 'aishell-credentials: chip hover styles')
}
