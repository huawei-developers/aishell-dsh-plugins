/**
 * Runtime favicon and manifest shadowing for the branded distribution.
 *
 * The browser tab icon comes from the dsh-web-frontend dist's
 * favicon.svg / favicon-dark.svg (a DeepSeek whale, one fixed fill per
 * theme, selected by the index's `media="(prefers-color-scheme: …)"`
 * links), and that dist tree is covered by the desktop-runtime digest —
 * the file-level swap cannot reach it. The plugin side therefore shadows
 * the links at runtime: every `link[rel~="icon"]` in the head has its
 * href rewritten to the AI Shell mark data URI. The mark's gradient
 * reads on both light and dark themes, so the media attribute is dropped
 * and one icon serves both.
 *
 * The web manifest's display names ("DeepSeek Harness" / "DSH") are
 * shadowed the same way when they can be: the manifest is fetched, the
 * name/short_name fields rewritten to "AI Shell", and the link pointed
 * at a Blob URL of the result. A manifest that cannot be fetched or
 * parsed is left exactly as found — a broken install prompt would cost
 * more than the name is worth.
 *
 * A MutationObserver watches the head, so a re-inserted icon or manifest
 * link (HMR, later injections) is re-shadowed as it appears.
 *
 * Shadowing is a default, not a force (plan §2.2): install() and the
 * disposer it returns are symmetric, so disabling the plugin restores
 * the official links exactly.
 *
 * @module @huaweidevtools/aishell-dsh-brand/client/favicon-shadow
 */

import { AISHELL_MARK_URI } from './aishell-mark.ts'

/** The disposer restores the official icon and manifest links; a no-op install returns this. */
export type FaviconShadowDisposer = () => void

/** The official product names the manifest shadow rewrites. */
const OFFICIAL_MANIFEST_NAMES = {
  name: 'DeepSeek Harness',
  short_name: 'DSH',
} as const

/** The branded names that shadow them. */
const BRANDED_MANIFEST_NAMES: Readonly<Record<keyof typeof OFFICIAL_MANIFEST_NAMES, string>> = {
  name: 'AI Shell',
  short_name: 'AI Shell',
}

/**
 * Rewrite a manifest document's display names in place.
 *
 * Only the two fields the dist actually ships are touched, and only when
 * they carry their official values — anything else in the document (icons,
 * start_url, scope, display) passes through untouched, and a manifest the
 * base customized keeps its customization.
 */
export function rebrandManifest(manifest: Record<string, unknown>): Record<string, unknown> {
  const branded: Record<string, unknown> = { ...manifest }
  for (const key of Object.keys(OFFICIAL_MANIFEST_NAMES) as (keyof typeof OFFICIAL_MANIFEST_NAMES)[]) {
    if (branded[key] === OFFICIAL_MANIFEST_NAMES[key]) branded[key] = BRANDED_MANIFEST_NAMES[key]
  }
  return branded
}

/** The href every icon link is shadowed with (exposed for the spec). */
export const BRANDED_ICON_HREF = AISHELL_MARK_URI

/**
 * One icon link's shadow record: the original href and media, kept so the
 * disposer can put the link back exactly as it was found.
 */
interface IconRestore {
  readonly link: HTMLLinkElement
  readonly href: string
  readonly media: string
}

/**
 * The rel token list of a link node, or undefined when the node is not a
 * link (comment nodes reach the same iterator).
 *
 * Duck-typed on the attribute rather than `instanceof HTMLLinkElement` so
 * the shadow works identically in the browser and under the specs' DOM
 * stub, which provides the attribute surface without the constructor.
 */
function linkRels(node: Node): string[] | undefined {
  if (node.nodeType !== Node.ELEMENT_NODE) return undefined
  const rel = (node as Element).getAttribute('rel')
  if (rel === null) return undefined
  return rel.split(/\s+/)
}

/**
 * Install the favicon shadow on a document.
 *
 * Rewrites every current icon link's href to the AI Shell mark (dropping
 * the media attribute so the one gradient serves both themes), shadows the
 * manifest names when the manifest is reachable, and observes the head so
 * re-inserted links are covered too. Returns the disposer: every touched
 * link is restored to its original href and media, the manifest link to
 * its original href, and the Blob URL is revoked, so an unload leaves the
 * document exactly as it was found.
 */
export function installFaviconShadow(target: Document): FaviconShadowDisposer {
  if (typeof target.querySelector !== 'function') return () => {}

  const iconRestores: IconRestore[] = []
  // The manifest link this install claimed, and what it must be restored
  // to. `manifestLink` doubles as the claim marker: once set, a later
  // response for a different link (or a second install's sweep) stands
  // down instead of racing it.
  let manifestLink: HTMLLinkElement | undefined
  let manifestHref: string | undefined
  let blobUrl: string | undefined

  const shadowIcon = (link: HTMLLinkElement): void => {
    if (iconRestores.some(restore => restore.link === link)) return
    iconRestores.push({ link, href: link.getAttribute('href') ?? '', media: link.getAttribute('media') ?? '' })
    link.setAttribute('href', BRANDED_ICON_HREF)
    // One gradient icon reads on both themes; the media qualifier would
    // keep toggling between the two whale variants that no longer exist.
    link.removeAttribute('media')
  }

  const shadowManifest = (link: HTMLLinkElement): void => {
    if (manifestLink !== undefined) return
    const href = link.getAttribute('href')
    if (href === null) return
    // Claim before the async work begins, so a second manifest link that
    // appears mid-flight cannot start a competing fetch.
    manifestLink = link
    // Relative manifest hrefs resolve against the document; the dist's own
    // `./manifest.webmanifest` spelling is preserved through this.
    const url = new URL(href, target.baseURI)
    void fetch(url)
      .then(response => (response.ok ? response.text() : Promise.reject(new Error(`HTTP ${response.status}`))))
      .then(text => {
        // The claim may have moved on (dispose or a re-shadow) — a late
        // response never writes onto a link it no longer owns.
        if (manifestLink !== link) return
        const parsed: unknown = JSON.parse(text)
        if (typeof parsed !== 'object' || parsed === null) throw new Error('manifest is not an object')
        const branded = rebrandManifest(parsed as Record<string, unknown>)
        const blob = new Blob([JSON.stringify(branded)], { type: 'application/manifest+json' })
        blobUrl = URL.createObjectURL(blob)
        manifestHref = href
        link.setAttribute('href', blobUrl)
      })
      .catch(() => {
        // Unreachable or unparseable: release the claim and leave the
        // official manifest alone — the install prompt must not break
        // over a display name. A later-arriving manifest link can retry.
        if (manifestLink === link) manifestLink = undefined
      })
  }

  const sweep = (root: ParentNode): void => {
    for (const link of root.querySelectorAll('link')) {
      const rels = linkRels(link)
      if (rels === undefined) continue
      if (rels.includes('icon')) shadowIcon(link)
      else if (rels.includes('manifest')) shadowManifest(link)
    }
  }

  sweep(target.head)

  const observer = new MutationObserver(mutations => {
    for (const mutation of mutations) {
      for (const node of mutation.addedNodes) {
        const rels = linkRels(node)
        if (rels === undefined) continue
        const element = node as Element
        if (rels.includes('icon')) shadowIcon(element as HTMLLinkElement)
        else if (rels.includes('manifest')) shadowManifest(element as HTMLLinkElement)
      }
    }
  })
  observer.observe(target.head, { childList: true })

  return () => {
    observer.disconnect()
    for (const { link, href, media } of iconRestores) {
      link.setAttribute('href', href)
      if (media !== '') link.setAttribute('media', media)
      else link.removeAttribute('media')
    }
    if (manifestLink !== undefined && manifestHref !== undefined) manifestLink.setAttribute('href', manifestHref)
    // Drop the claim even when the fetch never settled, so the disposer's
    // restore below is the final word on the link's href.
    manifestLink = undefined
    if (blobUrl !== undefined) URL.revokeObjectURL(blobUrl)
  }
}
