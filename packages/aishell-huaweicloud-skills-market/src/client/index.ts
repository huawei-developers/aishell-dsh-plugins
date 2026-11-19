/**
 * Huawei Cloud skills market, browser half: one tab on the Plugins page.
 *
 * ## Why this is a tab and where it sits
 *
 * The Plugins page already owns the frame a list of installable things needs:
 * the header, the tab row, the scrolling column, and the narrow-width layout.
 * Contributing a tab puts this catalogue beside Installed and Discover instead
 * of beside the whole page, which is what it is — a list of things to add.
 *
 * The `order` is negative so this tab sorts before the ones the page and its
 * other contributors register. `plugins.tab` is a list slot sorted by `order`,
 * and the shipped Discover tab registers without one (defaulting to 0) while
 * `dshmarket` pins itself at −1. −2 keeps this catalogue left of both, so the
 * row reads Installed, HuaweiCloud Skills, then whatever else is installed.
 *
 * ## Why the tab reads on entry and never on a timer
 *
 * The upstream repository changes when a skill author pushes, which is neither
 * predictable nor urgent, and the first read costs a clone. Reading on entry is
 * the one moment the person has said they care; the refresh control covers the
 * rest. A timer would spend a network round trip on every launch for a catalogue
 * most sessions never open.
 *
 * @module @huaweidevtools/aishell-dsh-huaweicloud-skills-market/client
 */

import type { Context as ClientContext } from '@deepseek-ai/cordis'
// Type-only: pulls the ctx.locale merge (the dictionary registry).
import type {} from '@deepseek-ai/dsh-client-locale/client'
// Type-only: pulls the ctx.slots merge and the `plugins.tab` slot declaration.
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-plugin-manager/client'

import { SkillsMarket, type SkillsMarketInjected } from './SkillsMarket.tsx'
import { createMarketStore } from './store.ts'
import { en, NS, zh } from './locales.ts'

export type { SkillsMarketInjected, SkillsMarketProps } from './SkillsMarket.tsx'
export { createMarketStore, type MarketStore, type MarketState } from './store.ts'
export { NS } from './locales.ts'

/**
 * The tab's id, and the locale namespace its copy resolves through.
 *
 * One string for both because the tab's label and its panel's copy are the same
 * subject; two ids would only be two places to keep in step.
 */
export const TAB_ID = NS

/**
 * Sort position: before the shipped Discover tab (0) and before `dshmarket` (−1).
 *
 * Chosen as its own value rather than by matching another contributor's: a tie
 * would be broken by registration order, so the tab would move depending on
 * which plugin the profile happened to mount first.
 */
const TAB_ORDER = -2

/** Services the browser half needs. */
export const inject = ['slots', 'locale']

/**
 * Contribute the tab.
 *
 * The store is created once per registration and closed over by `inject`, so a
 * tab switch away and back re-renders the same catalogue rather than reading it
 * again — and so the Host sees one read per session at most, not one per mount.
 *
 * @param ctx - the browser plugin context.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'aishell-huaweicloud-skills-market: dictionaries')
  const t = ctx.locale.bind(NS)
  const store = createMarketStore()

  ctx.effect(() => ctx.slots.inject('plugins.tab', () => ctx.slots.register({
    name: 'plugins.tab',
    id: TAB_ID,
    order: TAB_ORDER,
    label: () => t('tab.label'),
    locale: NS,
    inject: (): SkillsMarketInjected => ({ store }),
  }, SkillsMarket)), 'aishell-huaweicloud-skills-market: tab')
}