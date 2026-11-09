/**
 * AI Shell brand occupants for the DSH browser brand slots.
 *
 * Three components replace the default DeepSeek fish mark with the AI Shell
 * icon/logo, rendered through CSS modules so the SVG assets are inlined as
 * data URIs (no runtime fetch, no flash of missing image).
 */
import type { SidebarBrandMarkOwnerProps } from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type { HeroBrandMarkOwnerProps } from '@deepseek-ai/dsh-client-ui-conversation/client'
import styles from './brand.module.css'

// ── Hero headline patch ──────────────────────────────────────────────
// DSH renders t('hero.headline') as <span>Into the Unknown</span> inside
// .titleGroup. locale.register throws on duplicate namespaces, so we
// patch the DOM via JS: replace the span's text with three colored spans
// ("智联" blue, "华为云" huawei-red, "，部署零门槛" blue), then inject CSS
// for animations. dsh-web skins use the same CSS-patch approach.

const HERO_PATCH_CSS = [
  // Hero headline text follows the UI language: zh keeps the marketing
  // tagline, other languages fall back to the English one. The CSS content
  // cannot read the locale itself, so the text is driven by a variable that
  // the :lang selector switches.
  ':root { --aishell-hero-title: "Smart on Huawei Cloud, Smooth on Deployment"; }',
  ':lang(zh), :lang(zh-CN), :lang(zh-Hans) { --aishell-hero-title: "智联华为云，部署零门槛"; }',
  '@keyframes aishell-title-float {',
  '  0%, 100% { transform: none; }',
  '  35% { transform: translateY(-2px); }',
  '  70% { transform: translateY(1px); }',
  '}',
  '@keyframes aishell-gradient-flow {',
  '  0%, 100% { background-position: 0% 50%; }',
  '  50% { background-position: 100% 50%; }',
  '}',
  '@keyframes aishell-title-glow {',
  '  0%, 100% { text-shadow: 0 0 0 transparent; }',
  '  50% { text-shadow: 0 0 16px rgba(53, 137, 255, 0.5), 0 0 4px rgba(169, 38, 255, 0.3); }',
  '}',
  '@keyframes aishell-title-scale {',
  '  0%, 100% { transform: scale(1); }',
  '  50% { transform: scale(1.03); }',
  '}',
  '@keyframes aishell-logo-bob {',
  '  0%, 100% { transform: none; }',
  '  35% { transform: rotate(-4deg) translate(-0.4px, -0.9px); }',
  '  70% { transform: rotate(1.6deg) translate(0.3px, 0.2px); }',
  '}',
  '[class*="headline"] [class*="titleGroup"] > span:first-child {',
  '  font-size: 0;',
  '}',
  '[class*="headline"] [class*="titleGroup"] > span:first-child::after {',
  '  content: var(--aishell-hero-title);',
  '  display: inline-block;',
  '  vertical-align: middle;',
  '  white-space: nowrap;',
  '  font-size: 26px;',
  '  font-weight: 500;',
  '  line-height: 32px;',
  '  color: var(--dsw-alias-label-primary, #fff);',
  '  transform-origin: center;',
  '  transition: color 0.4s ease, background 0.6s ease;',
  '}',
  '@media (prefers-reduced-motion: no-preference) {',
  '  [class*="headline"] [class*="titleGroup"] > span:first-child::after {',
  '    animation: aishell-title-float 2s ease-in-out infinite;',
  '  }',
  '}',
  '@media (hover: hover) and (prefers-reduced-motion: no-preference) {',
  '  [class*="headline"] [class*="fishHitbox"]:hover ~ [class*="titleGroup"] > span:first-child::after,',
  '  [class*="headline"] [class*="titleGroup"] > span:first-child:hover::after {',
  '  background: linear-gradient(90deg, rgb(53, 137, 255), rgb(169, 38, 255), rgb(53, 137, 255));',
  '  background-size: 200% 100%;',
  '  -webkit-background-clip: text;',
  '  background-clip: text;',
  '  -webkit-text-fill-color: transparent;',
  '  animation: aishell-title-float 1.4s ease-in-out infinite, aishell-gradient-flow 2s ease-in-out infinite, aishell-title-glow 1.4s ease-in-out infinite, aishell-title-scale 1.4s ease-in-out infinite;',
  '  filter: brightness(1.1);',
  '  }',
  '  [class*="headline"] [class*="fishHitbox"]:hover [class*="fish"],',
  '  [class*="headline"] [class*="fish"].aishell-logo-hover {',
  '    animation: aishell-logo-bob 1.4s ease-in-out infinite;',
  '  }',
  '}',
  '[class*="headline"] [class*="titleGroup"] > span:last-child {',
  '  margin-top: -4px;',
  '}',
].join('\n')

/**
 * A disposer undoing one module-level installation.
 *
 * The three helpers below all reach outside React — a `<style>` tag, event
 * listeners, inserted nodes — so none of them is unwound by unmounting a
 * component. They are installed through `ctx.effect` in `index.ts`, which runs
 * the returned disposer on plugin unload. That matters beyond tidiness: the
 * client loader tears a module down with `tearDownEntryFiber` (fiber effects)
 * and `removeOwnedStyles` (only `style[data-plugin]` tags), so a bare
 * `MutationObserver` on `document.body` is reachable by neither and would
 * survive every HMR reload, accumulating one per reload.
 */
export type BrandDisposer = () => void

/** Inject the hero headline patch CSS; the disposer removes the tag. */
export function installHeroPatchCss(target: Document): BrandDisposer {
  if (typeof target.querySelector !== 'function') return () => {}
  if (target.querySelector('style[data-aishell-hero-patch]')) return () => {}
  const tag = target.createElement('style')
  tag.dataset.aishellHeroPatch = ''
  tag.textContent = HERO_PATCH_CSS
  target.head.appendChild(tag)
  return () => { tag.remove() }
}

/**
 * JS hover bridge: CSS ~ only matches forward siblings, so hovering the
 * title text cannot trigger the logo's animation (the logo sits before the
 * title in DOM order). This adds a mouseenter/mouseleave listener on the
 * title span that toggles a class on the logo to trigger its bob animation.
 *
 * The disposer removes both listeners from every span it bridged, so a reload
 * does not stack a second pair on the same element (the `data-` marker stops a
 * *re-install* from adding them, but it also means a later disposer cannot
 * find them by query alone — hence the bookkeeping below).
 */
export function installHeroHoverBridge(target: Document): BrandDisposer {
  if (typeof target.querySelector !== 'function') return () => {}

  /** Every listener this install added, so the disposer can take them off. */
  const bridged: Array<{
    element: HTMLElement
    onEnter: () => void
    onLeave: () => void
  }> = []

  const bridge = (root: ParentNode): void => {
    const groups = root.querySelectorAll<HTMLElement>('[class*="titleGroup"]')
    for (const group of groups) {
      const titleSpan = group.children[0] as HTMLElement | undefined
      if (!titleSpan || titleSpan.dataset.aishellHoverBridged === 'true') continue
      titleSpan.dataset.aishellHoverBridged = 'true'
      const onEnter = (): void => {
        const headline = titleSpan.closest('[class*="headline"]')
        const fish = headline?.querySelector<HTMLElement>('[class*="fish"]')
        fish?.classList.add('aishell-logo-hover')
      }
      const onLeave = (): void => {
        const headline = titleSpan.closest('[class*="headline"]')
        const fish = headline?.querySelector<HTMLElement>('[class*="fish"]')
        fish?.classList.remove('aishell-logo-hover')
      }
      titleSpan.addEventListener('mouseenter', onEnter)
      titleSpan.addEventListener('mouseleave', onLeave)
      bridged.push({ element: titleSpan, onEnter, onLeave })
    }
  }

  bridge(target)
  const observer = new MutationObserver((mutations) => {
    for (const m of mutations) {
      for (const node of m.addedNodes) {
        if (node.nodeType === 1) bridge(node as ParentNode)
      }
    }
  })
  observer.observe(target.body, { childList: true, subtree: true })

  return () => {
    observer.disconnect()
    for (const { element, onEnter, onLeave } of bridged) {
      element.removeEventListener('mouseenter', onEnter)
      element.removeEventListener('mouseleave', onLeave)
      delete element.dataset.aishellHoverBridged
      element.closest('[class*="headline"]')
        ?.querySelector<HTMLElement>('[class*="fish"]')
        ?.classList.remove('aishell-logo-hover')
    }
    bridged.length = 0
  }
}

/**
 * Render the AI Shell mark with the presentation requested by its host surface.
 * Used in both the expanded sidebar brand row and the collapsed rail.
 */
export function AishellBrandMark({ size }: SidebarBrandMarkOwnerProps) {
  return (
    <span
      className={styles.mark}
      style={{ width: size, height: size }}
      role="img"
      aria-label="AI Shell"
    />
  )
}

/**
 * Render the AI Shell name in the sidebar brand row. The product name itself
 * is drawn by the CSS module's `.name::before` (content: 'AI Shell'), so the
 * markup is a single empty span.
 */
export function AishellBrandName() {
  return <span className={styles.name} role="img" aria-label="AI Shell" />
}

/**
 * Render the AI Shell mark for the blank-session hero. Inherits the host's
 * className for surrounding mark geometry (e.g. centering).
 */
export function AishellHeroBrandMark({ size, className }: HeroBrandMarkOwnerProps) {
  return (
    <span
      className={`${styles.mark} ${className ?? ''}`.trim()}
      style={{ width: size, height: size }}
      role="img"
      aria-label="AI Shell"
    />
  )
}

/**
 * Insert "Powered by deepseek-harness" below the hero headline, centered
 * inside .stack. Uses a MutationObserver because the hero mounts/unmounts
 * as the user navigates between sessions.
 *
 * The disposer stops the observer and removes every label this install added,
 * so unloading the plugin leaves the hero exactly as it found it.
 */
export function installPoweredBy(target: Document): BrandDisposer {
  if (typeof target.querySelector !== 'function') return () => {}

  /** The labels this install inserted, for removal on dispose. */
  const inserted: HTMLElement[] = []

  const insert = (root: ParentNode): void => {
    const stacks = root.querySelectorAll<HTMLElement>('[class*="stack"]')
    for (const stack of stacks) {
      // Only insert into the hero .stack (it contains a .headline).
      if (!stack.querySelector('[class*="headline"]')) continue
      if (stack.querySelector('[data-aishell-powered-by]')) continue
      const label = target.createElement('div')
      label.dataset.aishellPoweredBy = ''
      label.style.cssText = 'text-align:center;font-size:11px;font-weight:400;line-height:16px;color:var(--dsw-alias-label-quaternary, #999);user-select:none;white-space:nowrap;'
      label.textContent = 'Powered by deepseek-harness'
      // Insert after the headline (first child of .stack).
      const headline = stack.querySelector('[class*="headline"]')
      if (headline && headline.nextSibling) {
        stack.insertBefore(label, headline.nextSibling)
      } else {
        stack.appendChild(label)
      }
      inserted.push(label)
    }
  }

  insert(target)
  const observer = new MutationObserver((mutations) => {
    for (const m of mutations) {
      for (const node of m.addedNodes) {
        if (node.nodeType === 1) insert(node as ParentNode)
      }
    }
  })
  observer.observe(target.body, { childList: true, subtree: true })

  return () => {
    observer.disconnect()
    for (const label of inserted) label.remove()
    inserted.length = 0
  }
}
