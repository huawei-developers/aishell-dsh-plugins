/**
 * aishell brand browser-half — occupies the generic browser-brand slots.
 *
 * Fills the sidebar brand slots (mark + name) and the conversation hero brand
 * mark, plus a "Powered by deepseek-harness" label in the sidebar footer.
 * Replaces the default DeepSeek fish mark with the AI Shell icon/logo.
 *
 * @module @huaweidevtools/aishell-dsh-brand/client
 */

import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
// Type-only: pulls the locale plugin's Context merge (ctx.locale).
import type {} from '@deepseek-ai/dsh-client-locale/client'
import {
  AishellBrandMark,
  AishellBrandName,
  AishellHeroBrandMark,
  installHeroHoverBridge,
  installHeroPatchCss,
  installPoweredBy,
} from './Brand.tsx'
import { SuggestionCards } from './SuggestionCards.tsx'
import { NS, zh, en } from './locales.ts'
import { installTitleShadow } from './title-shadow.ts'
import { installFaviconShadow } from './favicon-shadow.ts'
import { installRunningMarkShadow } from './running-mark-shadow.ts'
import { installRunningTextShadow } from './running-text-shadow.ts'

/** Required services: the UI slot registry and the locale registry. */
export const inject = ['slots', 'locale']

export function apply(ctx: ClientContext): void {
  // The suggestion cards are the only user-readable text this plugin owns,
  // and they must speak the reader's language — an English reader given a
  // Chinese prompt starts a Chinese conversation. Registered as its own
  // namespace: a namespace's texts have one owner, and `aishell` is taken by
  // the credentials plugin (a duplicate (ns, locale) registration throws).
  // The effect disposer makes an unload remove the dictionaries again.
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'aishell-brand: dictionaries')

  // priority: -1 shadows the official brand (priority 0, lower renders).
  ctx.slots.inject('sidebar.brand.mark', () =>
    ctx.slots.register({ name: 'sidebar.brand.mark', priority: -1 }, AishellBrandMark))
  ctx.slots.inject('sidebar.brand.name', () =>
    ctx.slots.register({ name: 'sidebar.brand.name', priority: -1 }, AishellBrandName))
  ctx.slots.inject('conversation.hero.brand.mark', () =>
    ctx.slots.register({ name: 'conversation.hero.brand.mark', priority: -1 }, AishellHeroBrandMark))
  // Example-prompt cards on the New-Session page, in the band between the
  // hero workspace row and the input card. A `list` entry composes beside
  // whatever else occupies that band (the credentials chip does) instead of
  // competing for one of the hero row's `single` seats, which official
  // occupants already hold. The component gates itself on `session.blank`,
  // so the strip disappears once the first message is sent.
  ctx.slots.inject('conversation.input.dock', () =>
    ctx.slots.register({
      name: 'conversation.input.dock',
      id: 'aishell-suggestions',
      order: 20,
      // Declaring the namespace is what supplies the `t` seat the component
      // reads; without it the cards would render blank keys.
      locale: NS,
    }, SuggestionCards))
  // The three brand residues below live in the digest-protected dsh tree
  // with no slot to occupy, so each is shadowed at runtime instead. Every
  // install returns a disposer and ctx.effect runs it when the plugin goes
  // away, restoring the official behavior (a default, not a force). Each
  // is a no-op outside a DOM environment.
  if (typeof document !== 'undefined') {
    // Hero headline patch CSS, its JS hover bridge, and the "Powered by"
    // label. These three reach outside React (a style tag, listeners,
    // inserted nodes), so they are installed here rather than at module load:
    // the client loader tears a module down with `tearDownEntryFiber` and
    // `removeOwnedStyles`, neither of which can reach a module-level
    // MutationObserver on document.body — it would survive every HMR reload.
    ctx.effect(() => installHeroPatchCss(document), 'aishell-brand: hero patch css')
    ctx.effect(() => installHeroHoverBridge(document), 'aishell-brand: hero hover bridge')
    ctx.effect(() => installPoweredBy(document), 'aishell-brand: powered-by label')
    // Window title: the product name in document.title is rewritten at
    // every write.
    ctx.effect(() => installTitleShadow(document), 'aishell-brand: window title shadow')
    // Browser tab icon (and, when reachable, the manifest display names):
    // the whale favicon links are repointed at the AI Shell mark.
    ctx.effect(() => installFaviconShadow(document), 'aishell-brand: favicon shadow')
    // Running-status whale tail: hidden and replaced by the AI Shell mark
    // through the same CSS-patch approach the hero headline uses.
    ctx.effect(() => installRunningMarkShadow(document), 'aishell-brand: running mark shadow')
    // Running-status copy: the per-second re-rendered line is rewritten
    // from "深度求索中 / Deep diving" to "思考中 / Thinking".
    ctx.effect(() => installRunningTextShadow(document), 'aishell-brand: running text shadow')
  }
}
