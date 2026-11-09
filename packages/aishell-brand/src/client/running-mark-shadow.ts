/**
 * Running-status whale-tail shadow for the branded distribution.
 *
 * ui-chat's RunningWhaleTail renders the DeepSeek whale: an APNG
 * (running-whale@2x.png) masked over currentColor inside a 14px
 * runningIcon box, with a static stroke SVG fallback for reduced motion.
 * All of it is digest-protected in the dsh tree, and there is no slot for
 * it — the row lives inside ui-chat's ChatView, which a plugin cannot
 * register into. The shadow therefore works the same way the hero
 * headline patch does (Brand.tsx): a CSS patch injected into the head,
 * anchored on the row's stable literal attribute [data-chat-running]
 * (RunningStatus.tsx writes it directly; the class names around it are
 * CSS-module hashes, so they are matched by the same [class*="…"]
 * substring selectors the hero patch already relies on).
 *
 * The patch hides both whale layers and repaints the runningIcon box with
 * the AI Shell mark (a data URI background), adding a gentle bob/pulse
 * that follows the official whale's degradation: under
 * prefers-reduced-motion the mark is static, matching the official
 * whale's own reduced-motion fallback.
 *
 * Shadowing is a default, not a force (plan §2.2): install() and the
 * disposer it returns are symmetric, so disabling the plugin restores
 * the official whale exactly.
 *
 * @module @huaweidevtools/aishell-dsh-brand/client/running-mark-shadow
 */

import { AISHELL_MARK_URI } from './aishell-mark.ts'

/** The disposer removes the patch style element; a no-op install returns this. */
export type RunningMarkShadowDisposer = () => void

/** Marker attribute the patch style element carries (exposed for the spec). */
export const RUNNING_PATCH_MARKER = 'data-aishell-running-mark'

/**
 * The patch CSS. The whale layers are hidden unconditionally — the static
 * fallback too, because the mark replaces both — while the mark's own
 * animation is guarded so reduced motion keeps it still.
 */
export const RUNNING_MARK_PATCH_CSS = [
  '[data-chat-running] [class*="runningWhaleAnimated"],',
  '[data-chat-running] [class*="runningWhaleStill"] {',
  '  display: none;',
  '}',
  '[data-chat-running] [class*="runningIcon"] {',
  `  background: url("${AISHELL_MARK_URI}") center / contain no-repeat;`,
  '}',
  '@keyframes aishell-running-bob {',
  '  0%, 100% { transform: none; opacity: 1; }',
  '  50% { transform: translateY(-0.7px); opacity: 0.82; }',
  '}',
  '@media (prefers-reduced-motion: no-preference) {',
  '  [data-chat-running] [class*="runningIcon"] {',
  '    animation: aishell-running-bob 1.2s ease-in-out infinite;',
  '  }',
  '}',
].join('\n')

/**
 * Install the running-mark shadow on a document.
 *
 * Injects the patch CSS once (guarded by the marker attribute so a second
 * install is a no-op) and returns the disposer that removes the element.
 */
export function installRunningMarkShadow(target: Document): RunningMarkShadowDisposer {
  if (typeof target.querySelector !== 'function') return () => {}
  const existing = target.querySelector(`style[${RUNNING_PATCH_MARKER}]`)
  if (existing !== null) return () => { existing.remove() }
  const tag = target.createElement('style')
  tag.setAttribute(RUNNING_PATCH_MARKER, '')
  tag.textContent = RUNNING_MARK_PATCH_CSS
  target.head.appendChild(tag)
  return () => { tag.remove() }
}
