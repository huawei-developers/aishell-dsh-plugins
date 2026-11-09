/**
 * Favicon shadow behavior.
 *
 * The web dist ships two whale favicons selected by prefers-color-scheme
 * media links, plus a manifest naming the product "DeepSeek Harness" /
 * "DSH" — all digest-protected, none reachable by the asar swap. What
 * this file pins is the runtime shadow that stands in for all three:
 *
 *   1. every icon link in the head is repointed at the AI Shell mark
 *      data URI, with the media qualifier dropped (the one gradient reads
 *      on both themes);
 *   2. a link re-inserted into the head later (HMR, later injections)
 *      is re-shadowed by the observer;
 *   3. the manifest link is repointed at a Blob URL whose document
 *      carries the branded names — and only the two name fields change;
 *      everything else in the manifest passes through untouched;
 *   4. a manifest that cannot be fetched or parsed is left exactly as
 *      found — a broken install prompt would cost more than the name;
 *   5. dispose restores every touched link to its original href and
 *      media and revokes the Blob URL (plan §2.2: an unload leaves the
 *      document exactly as it was found).
 *
 * The DOM is the tests/stub-dom.ts surface: the APIs the shadow touches
 * (link attributes, head childList observation, fetch + Blob URL) behave
 * identically on the stub, which is why the module accepts the document
 * as a parameter.
 */

import { describe, it, expect, vi, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { installFaviconShadow, rebrandManifest, BRANDED_ICON_HREF } from '../src/client/favicon-shadow.ts'
import { AISHELL_MARK_SVG, AISHELL_MARK_URI } from '../src/client/aishell-mark.ts'
import { makeStubDocument, installStubGlobals, record, StubMutationObserver, StubElement } from './stub-dom.ts'

/** The dist index.html's own icon links, as RunningStatus's world serves them. */
function distIconLinks(document: Document): void {
  const dark = document.createElement('link')
  dark.setAttribute('rel', 'icon')
  dark.setAttribute('type', 'image/svg+xml')
  dark.setAttribute('href', '/favicon-dark.svg')
  dark.setAttribute('media', '(prefers-color-scheme: dark)')
  document.head.appendChild(dark)
  const light = document.createElement('link')
  light.setAttribute('rel', 'icon')
  light.setAttribute('type', 'image/svg+xml')
  light.setAttribute('href', '/favicon.svg')
  light.setAttribute('media', '(prefers-color-scheme: light)')
  document.head.appendChild(light)
}

afterEach(() => { vi.unstubAllGlobals() })

describe('BRANDED_ICON_HREF / AISHELL_MARK_URI', () => {
  it('is the asset, verbatim, as a URL-encoded data URI', () => {
    const asset = readFileSync(fileURLToPath(new URL('../assets/aishell.svg', import.meta.url)), 'utf8').trim()
    expect(AISHELL_MARK_SVG).toBe(asset)
    expect(BRANDED_ICON_HREF).toBe(AISHELL_MARK_URI)
    expect(BRANDED_ICON_HREF.startsWith('data:image/svg+xml,')).toBe(true)
  })
})

describe('rebrandManifest', () => {
  it('rebrands the two display names the dist ships', () => {
    expect(rebrandManifest({
      name: 'DeepSeek Harness',
      short_name: 'DSH',
      start_url: './',
      scope: './',
      display: 'fullscreen',
      icons: [{ src: 'favicon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any' }],
    })).toEqual({
      name: 'AI Shell',
      short_name: 'AI Shell',
      start_url: './',
      scope: './',
      display: 'fullscreen',
      icons: [{ src: 'favicon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any' }],
    })
  })

  it('leaves a customized manifest alone', () => {
    expect(rebrandManifest({ name: 'Another Product', short_name: 'AP', start_url: './' }))
      .toEqual({ name: 'Another Product', short_name: 'AP', start_url: './' })
  })
})

describe('installFaviconShadow', () => {
  it('repoints every icon link at the mark and drops the media qualifier', () => {
    const uninstall = installStubGlobals()
    try {
      const document = makeStubDocument()
      distIconLinks(document)
      installFaviconShadow(document)
      const links = document.head.querySelectorAll('link')
      expect(links).toHaveLength(2)
      for (const link of links) {
        expect(link.getAttribute('href')).toBe(BRANDED_ICON_HREF)
        expect(link.getAttribute('media')).toBeNull()
        expect(link.getAttribute('rel')).toContain('icon')
      }
    } finally { uninstall() }
  })

  it('re-shadows an icon link re-inserted into the head later', () => {
    const uninstall = installStubGlobals()
    try {
      const document = makeStubDocument()
      distIconLinks(document)
      const dispose = installFaviconShadow(document)
      // The loader re-inserting the dist's icon links (what an HMR refresh does).
      const reinserted = new StubElement('link') as unknown as HTMLLinkElement
      reinserted.setAttribute('rel', 'icon')
      reinserted.setAttribute('href', '/favicon.svg')
      document.head.appendChild(reinserted)
      StubMutationObserver.lastInstance?.notify([
        record({ type: 'childList', target: document.head, addedNodes: [reinserted] }),
      ])
      expect(reinserted.getAttribute('href')).toBe(BRANDED_ICON_HREF)
      dispose()
    } finally { uninstall() }
  })

  it('leaves unrelated links untouched', () => {
    const uninstall = installStubGlobals()
    try {
      const document = makeStubDocument()
      distIconLinks(document)
      const stylesheet = new StubElement('link') as unknown as HTMLLinkElement
      stylesheet.setAttribute('rel', 'stylesheet')
      stylesheet.setAttribute('href', './assets/index.css')
      document.head.appendChild(stylesheet)
      installFaviconShadow(document)
      expect(stylesheet.getAttribute('href')).toBe('./assets/index.css')
      expect(stylesheet.getAttribute('rel')).toBe('stylesheet')
    } finally { uninstall() }
  })

  it('shadows the manifest names through a Blob URL when reachable', async () => {
    const official = JSON.stringify({
      name: 'DeepSeek Harness', short_name: 'DSH', start_url: './',
      scope: './', display: 'fullscreen',
      icons: [{ src: 'favicon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any' }],
    })
    // What the branded Blob was constructed from, and the URL it received.
    let blobParts: readonly string[] | undefined
    let createdUrl: string | undefined
    const originalCreateObjectURL = URL.createObjectURL
    const originalBlob = globalThis.Blob
    globalThis.Blob = class {
      public readonly parts: readonly string[]
      constructor(parts: readonly string[], _options?: BlobPropertyBag) { this.parts = parts }
    } as unknown as typeof Blob
    URL.createObjectURL = ((blob: Blob) => {
      blobParts = (blob as unknown as { parts: readonly string[] }).parts
      createdUrl = 'blob:https://shell.local/manifest'
      return createdUrl
    }) as typeof URL.createObjectURL
    const fetchImpl = (async () => new Response(official, { status: 200 })) as unknown as typeof fetch
    const uninstall = installStubGlobals(fetchImpl)
    try {
      const document = makeStubDocument()
      const manifest = new StubElement('link') as unknown as HTMLLinkElement
      manifest.setAttribute('rel', 'manifest')
      manifest.setAttribute('href', '/manifest.webmanifest')
      document.head.appendChild(manifest)
      const dispose = installFaviconShadow(document)
      await vi.waitFor(() => { expect(createdUrl).toBeDefined() })
      expect(manifest.getAttribute('href')).toBe('blob:https://shell.local/manifest')
      // The Blob document is the official manifest with only the names rebranded.
      expect(blobParts).toEqual([JSON.stringify({
        name: 'AI Shell', short_name: 'AI Shell', start_url: './',
        scope: './', display: 'fullscreen',
        icons: [{ src: 'favicon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any' }],
      })])
      dispose()
    } finally {
      URL.createObjectURL = originalCreateObjectURL
      globalThis.Blob = originalBlob
      uninstall()
    }
  })

  it('leaves the manifest link alone when it cannot be fetched', async () => {
    const fetchImpl = (async () => new Response('nope', { status: 404 })) as unknown as typeof fetch
    const uninstall = installStubGlobals(fetchImpl)
    try {
      const document = makeStubDocument()
      const manifest = new StubElement('link') as unknown as HTMLLinkElement
      manifest.setAttribute('rel', 'manifest')
      manifest.setAttribute('href', '/manifest.webmanifest')
      document.head.appendChild(manifest)
      const dispose = installFaviconShadow(document)
      await Promise.resolve()
      await Promise.resolve()
      expect(manifest.getAttribute('href')).toBe('/manifest.webmanifest')
      dispose()
    } finally { uninstall() }
  })

  it('dispose restores the official icon links exactly', () => {
    const uninstall = installStubGlobals()
    try {
      const document = makeStubDocument()
      distIconLinks(document)
      const dispose = installFaviconShadow(document)
      dispose()
      const links = [...document.head.querySelectorAll('link')]
      const hrefs = links.map(link => link.getAttribute('href'))
      expect(hrefs).toEqual(['/favicon-dark.svg', '/favicon.svg'])
      const medias = links.map(link => link.getAttribute('media'))
      expect(medias).toEqual(['(prefers-color-scheme: dark)', '(prefers-color-scheme: light)'])
    } finally { uninstall() }
  })

  it('returns a no-op disposer when the target has no DOM surface', () => {
    const dispose = installFaviconShadow({} as Document)
    expect(() => { dispose() }).not.toThrow()
  })

  it('a manifest response landing after dispose neither leaks a Blob URL nor writes the link', async () => {
    // The race the claim marker exists for. `blobUrl` is assigned inside the
    // fetch's `.then`, so a response arriving after dispose finds the
    // disposer already run — and the disposer cannot revoke a URL that did
    // not exist when it executed. If the late branch is not fenced, the URL
    // is created and never revoked (a leak that survives the unload) and the
    // link is repointed at a blob the plugin no longer owns.
    let createdUrl: string | undefined
    let revokedUrl: string | undefined
    let resolveFetch: ((response: Response) => void) | undefined
    const originalCreateObjectURL = URL.createObjectURL
    const originalRevokeObjectURL = URL.revokeObjectURL
    const originalBlob = globalThis.Blob
    globalThis.Blob = class {
      constructor(public readonly parts: readonly string[]) {}
    } as unknown as typeof Blob
    URL.createObjectURL = (() => { createdUrl = 'blob:https://shell.local/late'; return createdUrl }) as typeof URL.createObjectURL
    URL.revokeObjectURL = ((url: string) => { revokedUrl = url }) as typeof URL.revokeObjectURL

    // A fetch that stays pending until the spec releases it.
    const fetchImpl = (() => new Promise<Response>((resolve) => { resolveFetch = resolve })) as unknown as typeof fetch
    const uninstall = installStubGlobals(fetchImpl)
    try {
      const document = makeStubDocument()
      const manifest = new StubElement('link') as unknown as HTMLLinkElement
      manifest.setAttribute('rel', 'manifest')
      manifest.setAttribute('href', '/manifest.webmanifest')
      document.head.appendChild(manifest)

      const dispose = installFaviconShadow(document)
      // Dispose while the fetch is still in flight, then let it settle.
      dispose()
      resolveFetch!(new Response(JSON.stringify({ name: 'DeepSeek Harness', short_name: 'DSH' }), { status: 200 }))
      // Let the chain finish: `.then(response => response.text())` resolves
      // through the body stream, so microtask drains alone are not enough —
      // a macrotask turn is what proves the late branch ran (or did not).
      await new Promise(resolve => setTimeout(resolve, 0))
      await new Promise(resolve => setTimeout(resolve, 0))

      // The late response must not have created a URL at all — the claim
      // marker (`manifestLink !== link`) is what stands it down. Without that
      // fence this assertion fails: the blob is created and never revoked,
      // surviving the unload.
      expect(createdUrl).toBeUndefined()
      // And the link still carries what dispose restored.
      expect(manifest.getAttribute('href')).toBe('/manifest.webmanifest')
      void revokedUrl
    } finally {
      URL.createObjectURL = originalCreateObjectURL
      URL.revokeObjectURL = originalRevokeObjectURL
      globalThis.Blob = originalBlob
      uninstall()
    }
  })
})
