/**
 * Shared tsdown preset for aishell client plugin bundles.
 *
 * Emits a closure-factory artifact: the bundle calls
 * `window.__ModuleLoader__.load({ id, factory })` and resolves externals
 * through the injected require (the loader module table — cordis DI entities,
 * no globals, no import map). CSS Modules are compiled by lightningcss inside
 * the bundle: importing `x.module.css` yields the hashed class map, and the
 * css text auto-injects a `<style data-plugin="<id>">` tag at factory
 * execution (the loader removes plugin-owned tags on unload).
 *
 * Adapted from dsh-web's `shared/tsdown.client.ts`, stripped to the essentials
 * (no store-engine shim, no purity gate, no build-face selection — aishell
 * packages are simple enough to not need them).
 */
import { readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { isAbsolute, resolve as resolvePath, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { UserConfig } from 'tsdown'
import { transform } from 'lightningcss'

/** Platform modules the shell shares into the frozen module table (0.1.6-alpha.2 cohort). */
const PLATFORM_EXTERNALS: readonly string[] = [
  'react', 'react/jsx-runtime', 'react-dom', 'react-dom/client',
  '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-store',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-ui-primitives',
  '@deepseek-ai/dsh-client-ui-dockkit',
]

/**
 * Virtual-id wrapper keeping module CSS away from tsdown's own css pipeline
 * (which requires @tsdown/css). The suffix matters: tsdown's guard matches ids
 * ending in `.css`, so the virtual id must not.
 */
const CSS_VIRTUAL_PREFIX = '\0dsh-css:'
const CSS_VIRTUAL_SUFFIX = '.mjs'

const isExternal = (source: string): boolean =>
  PLATFORM_EXTERNALS.some(p => source === p || source.startsWith(p + '/'))

/** Resolve a CSS module import path relative to its importer. */
function sourceAssetPath(source: string, importer: string): string {
  if (isAbsolute(source)) return source
  return resolvePath(resolvePath(importer, '..'), source)
}

/**
 * Build the tsdown config for one aishell client plugin package: the node-half
 * lib build plus the browser client bundle.
 * @param id - plugin id (package name), stamped into the __ModuleLoader__.load
 * handoff and onto the injected style tags.
 * @param libEntry - node-half entries.
 * @returns tsdown config array (node + client).
 */
export function clientBundle(id: string, libEntry: readonly string[]): UserConfig[] {
  const BANNER = `window.__ModuleLoader__.load({ id: "${id}", factory: (require) => {`
  const FOOTER = 'return module.exports; } });'
  const INTRO = 'var module = { exports: {} }; var exports = module.exports;'

  const hasClient = existsSync(resolvePath(process.cwd(), 'src/client/index.ts'))

  const nodeConfig: UserConfig = {
    name: `${id}/node`,
    entry: libEntry,
    outDir: 'lib',
    format: ['esm'],
    platform: 'node',
    target: 'es2024',
    fixedExtension: false,
    dts: true,
    clean: true,
  }

  if (!hasClient) return [nodeConfig]

  const clientConfig: UserConfig = {
    name: `${id}/client`,
    entry: { client: 'src/client/index.ts' },
    outDir: 'lib',
    format: ['cjs'],
    platform: 'browser',
    target: 'es2024',
    fixedExtension: false,
    dts: false,
    clean: false,
    sourcemap: true,
    external: isExternal,
    outputOptions: {
      entryFileNames: 'client.js',
      banner: BANNER,
      footer: FOOTER,
      intro: INTRO,
    },
    plugins: [{
      name: 'aishell-css-modules',
      resolveId(source: string, importer: string | undefined) {
        if (!source.endsWith('.module.css')) return null
        const abs = importer !== undefined ? sourceAssetPath(source, importer) : source
        return CSS_VIRTUAL_PREFIX + abs + CSS_VIRTUAL_SUFFIX
      },
      async load(virtualId: string) {
        if (!virtualId.startsWith(CSS_VIRTUAL_PREFIX)) return null
        const fileId = virtualId.slice(CSS_VIRTUAL_PREFIX.length, -CSS_VIRTUAL_SUFFIX.length)
        this.addWatchFile(fileId)
        let source = (await readFile(fileId)).toString('utf8')
        // Inline url() references to local assets (SVG, PNG, etc.) as data URIs
        // so the bundle is self-contained — the browser closure-factory has no
        // file system to resolve relative paths against. Collect matches first,
        // then replace sequentially (String.replace does not await async callbacks).
        const urlPattern = /url\(\s*['"]?([^'")]+)['"]?\s*\)/g
        const matches: { full: string; ref: string }[] = []
        for (const m of source.matchAll(urlPattern)) {
          matches.push({ full: m[0], ref: m[1] })
        }
        for (const { full, ref } of matches) {
          if (ref.startsWith('data:') || ref.startsWith('http:') || ref.startsWith('https:')) continue
          const assetPath = resolvePath(resolvePath(fileId, '..'), ref)
          this.addWatchFile(assetPath)
          try {
            const assetSource = await readFile(assetPath)
            const ext = assetPath.split('.').pop()?.toLowerCase() ?? ''
            const mime = ext === 'svg' ? 'image/svg+xml' : ext === 'png' ? 'image/png' : ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg' : 'application/octet-stream'
            const dataUri = `data:${mime};base64,${assetSource.toString('base64')}`
            source = source.replace(full, `url('${dataUri}')`)
          } catch {
            // Asset unreadable — leave the url() as-is.
          }
        }
        const { code, exports: cssExports } = transform({
          filename: fileId.split(sep).join('/'),
          code: Buffer.from(source, 'utf8'),
          cssModules: { pattern: '[hash]_[local]' },
          minify: true,
        })
        const classMap: Record<string, string> = {}
        for (const [local, exp] of Object.entries(cssExports ?? {}).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) {
          classMap[local] = exp.name
        }
        return [
          `const css = ${JSON.stringify(code.toString())};`,
          `const tagId = ${JSON.stringify(`${id}/${fileId}`)};`,
          'if (typeof document !== \'undefined\' && document.querySelector(\'style[data-plugin-css=\' + JSON.stringify(tagId) + \']\') === null) {',
          '  const tag = document.createElement(\'style\');',
          `  tag.dataset.plugin = ${JSON.stringify(id)};`,
          '  tag.dataset.pluginCss = tagId;',
          '  tag.textContent = css;',
          '  document.head.appendChild(tag);',
          '}',
          `export default ${JSON.stringify(classMap)};`,
        ].join('\n')
      },
    }],
  }

  return [nodeConfig, clientConfig]
}
