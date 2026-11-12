/**
 * Deep-link transport, Page half.
 *
 * Opens the Host's event stream and dispatches each URL to the plugin that
 * claimed its family. A URL that arrives before any plugin has claimed its
 * family is held and replayed on the claim, because the Page can receive a
 * link while its own plugin tree is still assembling.
 *
 * This half declares no required services: `EventSource` needs only the page's
 * own origin, and gating activation on the RPC transport would delay the stream
 * for a service nothing here calls.
 *
 * @module @huaweidevtools/aishell-dsh-deeplink/client
 */

import type { Context as ClientContext } from '@deepseek-ai/cordis'

import { admit, type DeepLink } from '../link.ts'
import { DEEPLINK_CLIENT_ROUTE } from '../route.ts'

export { DEEPLINK_CLIENT_ROUTE, DEEPLINK_ROUTE } from '../route.ts'

export const name = 'aishell-deeplink'

/** No required services; see the module note. */
export const inject: readonly string[] = []

/**
 * Links held until a plugin claims their family.
 *
 * This buffer covers the span between the Page being loaded and a plugin
 * claiming its family: milliseconds of ordinary loading. It exists only because
 * that order is not fixed — the stream can deliver before the owning plugin's
 * `claim()` runs.
 *
 * Entries drain on a claim, so nothing ages out on a timer: an entry leaves when
 * its family is claimed, or when the bound passes it. A family no plugin ever
 * claims therefore holds at most this many entries and no more. The bound is
 * slightly larger than the window needs; it is here to stop unbounded growth, not
 * to be a tuned limit.
 */
export const MAX_WAITING = 16

/** The claim registry, provided by this half. */
export interface AishellDeepLinks {
  /**
   * Claim one link family.
   *
   * @param family - the URL hostname segment, lowercase, e.g. `share`.
   * @param handler - invoked for every URL carrying that hostname, including
   *   ones that arrived before this claim.
   * @returns disposer that releases the claim.
   * @throws when the family is already claimed by a live registration.
   */
  claim(family: string, handler: (url: URL) => void): () => void
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /**
     * The claim surface, provided by this plugin's Page half and consumed by a
     * plugin that owns a link family.
     */
    aishellDeepLinks: AishellDeepLinks
  }
}

export function apply(ctx: ClientContext): void {
  const claims = new Map<string, (url: URL) => void>()
  const waiting: DeepLink[] = []

  const dispatch = (link: DeepLink): void => {
    const handler = claims.get(link.family)
    if (handler !== undefined) {
      handler(new URL(link.href))
      return
    }
    waiting.push(link)
    if (waiting.length > MAX_WAITING) waiting.shift()
  }

  ctx.provide('aishellDeepLinks', {
    claim(family: string, handler: (url: URL) => void): () => void {
      const key = family.toLowerCase()
      if (claims.has(key)) {
        throw new Error(`deep link family "${key}" is already claimed`)
      }
      claims.set(key, handler)
      // Walk forward so a replayed batch keeps the order the links arrived in:
      // a backwards walk would hand the handler the newest first.
      const replayed = waiting.filter((link) => link.family === key)
      for (const link of replayed) {
        const index = waiting.indexOf(link)
        if (index >= 0) waiting.splice(index, 1)
        handler(new URL(link.href))
      }
      return () => {
        if (claims.get(key) === handler) claims.delete(key)
      }
    },
  })

  ctx.effect(() => {
    const source = new EventSource(DEEPLINK_CLIENT_ROUTE)
    source.addEventListener('message', (event: MessageEvent<string>): void => {
      let href: unknown
      try {
        href = (JSON.parse(event.data) as { url?: unknown }).url
      } catch {
        return
      }
      if (typeof href !== 'string') return
      const link = admit(href)
      if (link === undefined) return
      dispatch(link)
    })
    return () => { source.close() }
  }, 'aishell-deeplink: stream')
}