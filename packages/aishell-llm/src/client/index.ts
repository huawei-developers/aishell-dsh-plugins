/**
 * aishell LLM browser half — shadows the Models page's provider row.
 *
 * The page's row for the aishell family is read-only: its profile has no
 * fields the host editor knows how to write, and its credentials are entered
 * through the credential form the `aishell-credentials` chips open. The one
 * fact the row should carry is readiness, so the browser half paints it as a
 * status dot beside the row's name and hides the header's Edit button (see
 * `client/provider-row-shadow.ts`).
 *
 * The readiness fact is read from the `aishell-client-credentials` settings
 * namespace (`aishell-credentials` owns it; the shadow never names accounts
 * or manages anything). The shadow follows that namespace through
 * `whileServed`, so a deployment without that plugin (this LLM package
 * installed standalone) shows no trace of the dot either — the fact is
 * unknown, not false.
 *
 * The dot's hover copy rides this package's own locale namespace. The shadow
 * is a DOM patch that does not re-render on a locale switch, so the install
 * is redone on `locale/change` — the repaint is attribute writes over rows
 * the sweep re-finds, not a page mutation.
 *
 * @module @huaweidevtools/aishell-dsh-llm/client
 */

import type { Context as ClientContext } from '@deepseek-ai/cordis'
// Type-only: pulls the ctx.configForms merge (the settings mirror's read
// face, used for the credential-presence derivation below).
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
// Type-only: pulls the ctx.locale merge (the dictionary registry) and the
// `locale/change` event.
import type {} from '@deepseek-ai/dsh-client-locale/client'
import { installProviderRowShadow, type ProviderRowTitles } from './provider-row-shadow.ts'
import { NS, zh, en } from './locales.ts'

export type {
  ProviderRowShadowDisposer,
  ProviderRowTitles,
} from './provider-row-shadow.ts'
export {
  installProviderRowShadow,
  ROW_DOT_MARKER,
  ROW_EDIT_HIDDEN,
} from './provider-row-shadow.ts'

/** The settings namespace aishell-credentials owns (the shadow reads its status). */
const AISHELL_CREDENTIALS_NS = 'aishell-client-credentials'

/** The non-secret status field the shadow derives from that namespace. */
interface AishellSettings {
  readonly credentialsStored?: boolean
}

/** Required services. */
export const inject = ['configForms', 'locale']

export function apply(ctx: ClientContext): void {
  // The row shadow is a browser-side patch; outside a DOM environment (the
  // specs' Node run) there is no Models page to shadow and the install is a
  // no-op.
  if (typeof document === 'undefined') return

  // Register this package's dictionary so the dot's copy follows the active
  // locale; `bind` reads the active language at call time, so every reinstall
  // below picks up whatever language is current.
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'aishell-llm: dictionaries')
  const t = ctx.locale.bind(NS)

  const form = ctx.configForms.get<AishellSettings>(AISHELL_CREDENTIALS_NS)
  let readiness = form.getSnapshot().value?.credentialsStored === true
  let disposeShadow: (() => void) | undefined

  // The hover copy in the active locale, read per install.
  const titles = (): ProviderRowTitles => ({
    ok: t('provider.ready'),
    warn: t('provider.warn'),
  })

  // A reinstall with the fresh fact repaints the dot; the shadow module
  // keeps the DOM work, so this derivation only owns the fact.
  const sync = (): void => {
    disposeShadow?.()
    disposeShadow = installProviderRowShadow(document, readiness, titles())
  }
  const derive = (): void => {
    const next = form.getSnapshot().value?.credentialsStored === true
    if (next !== readiness) {
      readiness = next
      sync()
    }
  }

  // The namespace is aishell-credentials', so the shadow follows it through
  // `whileServed` — a deployment without that plugin shows no trace of the
  // dot instead of painting a permanently-warn one.
  ctx.effect(() => ctx.configForms.whileServed([AISHELL_CREDENTIALS_NS], () => {
    sync()
    return () => { disposeShadow?.(); disposeShadow = undefined }
  }), 'aishell-llm: models page provider row shadow')
  ctx.effect(() => form.subscribe(derive), 'aishell-llm: credential presence for the models row')

  // A locale switch does not re-render a DOM patch, so the install is redone
  // when the language changes — the dot's title and aria-label are the only
  // locale-dependent attributes, and the repaint is idempotent.
  ctx.effect(() => ctx.on('locale/change', () => { sync() }), 'aishell-llm: shadow locale repaint')
}
