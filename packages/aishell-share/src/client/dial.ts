/**
 * The dial: the twelve-dot ring a working state shows, with its label in the
 * middle.
 *
 * ## Why this is not imported from the credentials package
 *
 * `aishell-dsh-client-credentials` has a dial of its own, and copying its
 * recipe is a real cost — two places to keep in step. Importing it is worse:
 * a client bundle is a closure factory the loader hands a module table to, not
 * a library, so one plugin importing another's `client` entry is a coupling
 * the loader was built to prevent (neither package's `dsh.client.inject`
 * promises the other is mounted, and a standalone install of this package
 * would not have it at all). So the recipe lives here, and the two are kept
 * alike by being written from the same description rather than by sharing
 * code across a package boundary that cannot carry it.
 *
 * ## Why a style tag rather than inline styles
 *
 * `@keyframes` has no inline form. The ring's whole character is motion, so it
 * needs a rule. Everything static stays in the component, next to its markup.
 *
 * ## The ring
 *
 * Twelve dots on one circle, each a little larger and more opaque than the one
 * before, so the ring reads as one arc with a head and a tail rather than as
 * twelve separate marks. The geometry is derived in CSS from one number per dot
 * (`--i`, set inline), so {@link DIAL_DOT_COUNT} is the only thing to change to
 * re-space it.
 *
 * ## Reduced motion
 *
 * Decorative: the label already says what is happening, so the media query
 * simply stops the ring, with no state for the component to hold.
 *
 * @module @huaweidevtools/aishell-dsh-share/client/dial
 */

import type { Context as ClientContext } from '@deepseek-ai/cordis'

/** Plugin id stamped on the tag, so the loader can sweep it on teardown. */
const PLUGIN_ID = '@huaweidevtools/aishell-dsh-share'

/** Dedupe key, as `shared/tsdown.client.ts` spells it for generated modules. */
const STYLE_KEY = 'dial.css'

/** Class on the box the ring and its centre label share. */
export const DIAL_CLASS = 'aishell-share-dial'

/** Class on the rotating ring itself. */
export const DIAL_RING_CLASS = 'aishell-share-dial-ring'

/** Class on one dot. Carries `--i`, its position around the ring. */
export const DIAL_DOT_CLASS = 'aishell-share-dial-dot'

/** Class on the label in the middle of the ring. */
export const DIAL_LABEL_CLASS = 'aishell-share-dial-label'

/**
 * How many dots the ring is drawn from.
 *
 * Twelve gives one dot every 30°, which reads as a continuous arc at this size.
 * The component maps over this, so the ring and the CSS cannot disagree about
 * its length.
 */
export const DIAL_DOT_COUNT = 12

const CSS = `
.${DIAL_CLASS} {
  position: relative;
  width: 104px;
  height: 104px;
  /* Centred in its column: while a step is running the dial is the card's
     focal point. */
  margin: 0 auto;
  display: grid;
  place-items: center;
}

/* \`inset: 0\` with \`margin: auto\` centres the ring without touching
   \`transform\`, which the rotation owns — a translate-based centring would be
   overwritten by every frame of the animation. */
.${DIAL_RING_CLASS} {
  position: absolute;
  inset: 0;
  margin: auto;
  width: 78px;
  height: 78px;
  animation: aishell-share-spin 1.8s linear infinite;
}

/* One dot. The box is the whole ring square, rotated into place; the dot is
   drawn by \`::before\` pinned to the box's top edge. */
.${DIAL_DOT_CLASS} {
  position: absolute;
  inset: 0;
  transform: rotate(calc(var(--i) * 30deg));
}

.${DIAL_DOT_CLASS}::before {
  content: '';
  position: absolute;
  left: 50%;
  top: 0;
  /* 0 at the tail, 1 at the head: the ramp drives both size and opacity, which
     is what makes the ring read as one sweeping arc. */
  --t: calc(var(--i) / ${String(DIAL_DOT_COUNT - 1)});
  width: calc(3px + var(--t) * 6px);
  height: calc(3px + var(--t) * 6px);
  border-radius: 50%;
  background: var(--dsw-alias-button-primary-fill);
  opacity: calc(0.15 + var(--t) * 0.85);
  /* Half-translate so the dot is centred on the circle rather than hanging
     inside it, and so a size change does not shift the dot's own centre. */
  transform: translate(-50%, -50%);
}

.${DIAL_LABEL_CLASS} {
  position: relative;
  font-size: 12px;
  font-weight: 500;
  line-height: 16px;
  color: var(--dsw-alias-label-secondary);
  text-align: center;
  /* A four-glyph label ("生成链接") at 12px is 48px; the cap keeps it off the
     ring's inner edge without shrinking the ring. */
  max-width: 64px;
  text-wrap: balance;
}

@keyframes aishell-share-spin {
  to { transform: rotate(360deg); }
}

/* Decorative motion only — the label says what is happening. */
@media (prefers-reduced-motion: reduce) {
  .${DIAL_RING_CLASS} { animation: none; }
}
`

/**
 * Install the stylesheet, once per plugin fiber.
 *
 * @param ctx - client context, for the effect that owns the tag.
 */
export function installDialStyles(ctx: ClientContext): void {
  if (typeof document === 'undefined') return
  ctx.effect(() => {
    const tag = document.createElement('style')
    tag.dataset.plugin = PLUGIN_ID
    tag.dataset.pluginCss = STYLE_KEY
    tag.textContent = CSS
    document.head.appendChild(tag)
    return () => { tag.remove() }
  }, 'aishell-share: dial styles')
}