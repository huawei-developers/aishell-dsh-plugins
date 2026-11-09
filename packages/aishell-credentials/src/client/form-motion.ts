/**
 * The animation the credential card needs, as a stylesheet.
 *
 * ## Why a style tag rather than inline styles
 *
 * `@keyframes` does not exist inline — there is no `style` property for it —
 * and the running state's whole character is motion: a ring of dots that grows
 * from faint to solid as it sweeps, and a progress line that drains as the
 * login window closes. Both need a rule, so both live here. The card's static
 * styling stays inline where it is, next to the markup it belongs to; only what
 * CSS alone can express is in this file.
 *
 * ## The dial
 *
 * Twelve dots on one circle, each a little larger and more opaque than the one
 * before it, so the ring reads as a single arc with a head and a tail rather
 * than as twelve separate marks. The whole ring rotates; the label in the
 * middle and the countdown below it do not.
 *
 * The sizes and the ramp are derived in CSS from one number per dot (`--i`,
 * set inline by the component) rather than stamped out as twelve rules. That
 * keeps {@link DIAL_DOT_COUNT} the only thing to change to re-space the ring,
 * and it means the component holds no styling decision beyond the dot count.
 *
 * ## Why `prefers-reduced-motion` is handled here, not in React
 *
 * The brand package reads the query through `matchMedia` in a hook and stops
 * its carousel from JavaScript. That is right for a carousel, where stopping
 * means not advancing a timer at all. Here the motion is decorative: the ring
 * and the line carry no information the text does not, so the media query can
 * simply turn them off in CSS with no state for the component to hold. That
 * also means it works on the first paint, before hydration.
 *
 * ## The dedupe key
 *
 * Stamped with the plugin id and a CSS-module-style key, matching
 * `./huawei-mark.ts` and the build-time modules. The loader's
 * `removeOwnedStyles` sweeps `style[data-plugin="<id>"]` on teardown, so a
 * reload that re-registers this cannot leave two copies fighting.
 *
 * @module @huaweidevtools/aishell-dsh-client-credentials/client/form-motion
 */

import type { Context as ClientContext } from '@deepseek-ai/cordis'

/** Plugin id stamped on the tag, so the loader can sweep it on teardown. */
const PLUGIN_ID = '@huaweidevtools/aishell-dsh-client-credentials'

/** Dedupe key, as `shared/tsdown.client.ts` spells it for generated modules. */
const STYLE_KEY = 'form-motion.css'

/** Class on the box the dot ring and the centre label share. */
export const DIAL_CLASS = 'aishell-cred-dial'

/** Class on the rotating ring itself. */
export const DIAL_RING_CLASS = 'aishell-cred-dial-ring'

/** Class on one dot. Carries `--i`, its position around the ring. */
export const DIAL_DOT_CLASS = 'aishell-cred-dial-dot'

/** Class on the label in the middle of the ring. */
export const DIAL_LABEL_CLASS = 'aishell-cred-dial-label'

/**
 * How many dots the ring is drawn from.
 *
 * Twelve gives one dot every 30°, which reads as a continuous arc at this size.
 * The component maps over this, so the ring and the CSS cannot disagree about
 * its length.
 */
export const DIAL_DOT_COUNT = 12

/** Class on the progress line that drains the login window. */
export const PROGRESS_CLASS = 'aishell-cred-progress'

/** Class on the track the progress line sits in. */
export const PROGRESS_TRACK_CLASS = 'aishell-cred-progress-track'

/**
 * The rules.
 *
 * Colours come from the theme's alias tokens wherever one exists, so the card
 * follows light and dark the way every other surface does.
 */
const CSS = `
.${DIAL_CLASS} {
  position: relative;
  width: 104px;
  height: 104px;
  /* Centred in its column: the dial is the card's focal point while a login
     runs, and the countdown beneath it lines up with the dial's own centre. */
  margin: 0 auto;
  display: grid;
  place-items: center;
}

/* The ring is a fixed square centred inside the dial. \`inset: 0\` with
   \`margin: auto\` is what centres it without touching \`transform\` — the
   rotation owns that property, and a translate-based centring would be
   overwritten by every frame of the animation. */
.${DIAL_RING_CLASS} {
  position: absolute;
  inset: 0;
  margin: auto;
  width: 78px;
  height: 78px;
  animation: aishell-cred-spin 1.8s linear infinite;
}

/* One dot. The box is the whole ring square and is rotated into place; the dot
   itself is drawn by \`::before\` pinned to the box's top edge. Generating the
   geometry in CSS from \`--i\` keeps twelve rules from having to be written out
   and kept in step with the dot count. */
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
  /* 0 at the tail, 1 at the head: the ramp drives both the size and the
     opacity, which is what makes the ring read as one sweeping arc. */
  --t: calc(var(--i) / ${String(DIAL_DOT_COUNT - 1)});
  width: calc(3px + var(--t) * 6px);
  height: calc(3px + var(--t) * 6px);
  border-radius: 50%;
  background: var(--dsw-alias-button-primary-fill);
  opacity: calc(0.15 + var(--t) * 0.85);
  /* Half-translate so the dot is centred on the circle rather than hanging
     inside it — and so a size change does not shift the dot's own centre. */
  transform: translate(-50%, -50%);
}

.${DIAL_LABEL_CLASS} {
  position: relative;
  font-size: 12px;
  font-weight: 500;
  line-height: 16px;
  color: var(--dsw-alias-label-secondary);
  text-align: center;
  /* The longest label is two CJK glyphs; a little padding keeps the text off
     the ring's inner edge without shrinking the ring. */
  max-width: 62px;
  text-wrap: balance;
}

@keyframes aishell-cred-spin {
  to { transform: rotate(360deg); }
}

/* The track the draining line sits in. Narrower than the card so it reads as
   part of the dial group above it rather than as a full-width rule. */
.${PROGRESS_TRACK_CLASS} {
  display: block;
  width: 168px;
  height: 2px;
  border-radius: 1px;
  margin: 0 auto;
  background: var(--dsw-alias-border-l4);
}

/* Width is set inline from the countdown — a CSS animation would drift out of
   step with the wall-clock deadline the text shows, and the two disagreeing is
   worse than no line at all. */
.${PROGRESS_CLASS} {
  display: block;
  height: 2px;
  border-radius: 1px;
  background: var(--dsw-alias-button-primary-fill);
  transition: width 1s linear;
}

/* Decorative motion only. Both animations carry information that is already in
   the text beside them, so removing them loses nothing. */
@media (prefers-reduced-motion: reduce) {
  .${DIAL_RING_CLASS} { animation: none; }
  .${PROGRESS_CLASS} { transition: none; }
}
`

/**
 * Install the stylesheet, once per plugin fiber.
 *
 * @param ctx - client context, for the effect that owns the tag.
 */
export function installFormMotionStyles(ctx: ClientContext): void {
  if (typeof document === 'undefined') return
  ctx.effect(() => {
    const tag = document.createElement('style')
    tag.dataset.plugin = PLUGIN_ID
    tag.dataset.pluginCss = STYLE_KEY
    tag.textContent = CSS
    document.head.appendChild(tag)
    return () => { tag.remove() }
  }, 'aishell-credentials: form motion styles')
}
