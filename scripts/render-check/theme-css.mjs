#!/usr/bin/env node
/**
 * Copy the shell's own theme CSS out of the installed DSH, so the preview and
 * the render check paint against the REAL palette.
 *
 * ## Why this exists
 *
 * The preview page and the render harness both used to hand-copy a subset of
 * `--dsw-*` tokens with plausible-looking values. That is a trap, and it
 * sprang twice in one session:
 *
 *   1. the harness had `--dsw-alias-interactive-bg-hover: #ececef`, an OPAQUE
 *      grey, where the shell's real token is a translucent `#2631480f`. The
 *      card's design argument rests on that alpha, so the suite was asserting
 *      something the product never does;
 *   2. when cards started drawing their tiles from the `--dsw-static-*`
 *      palette, three of the four computed to `transparent` on BOTH pages,
 *      because neither had ever defined those tokens. On the real page they
 *      exist — `@deepseek-ai/dsh-client-ui-theme` injects them into a <style>
 *      at load. The preview was showing a page missing half the palette and
 *      nobody could tell by looking.
 *
 * Copying the real CSS removes the whole class of problem: there is nothing
 * left to get subtly wrong, and a token the shell adds is picked up by
 * re-running this.
 *
 * ## What it writes
 *
 * `.render-check/theme.css` — the theme package's own literals, concatenated
 * in the order the package registers them, plus the theme's `data-ds-dark-theme`
 * rules (which are inside `design_platform_css_default`). Both pages link it
 * BEFORE their own styles, so page-local rules still win where they mean to.
 *
 * The file is generated, not committed to hand-editing: `.render-check/` is the
 * staging directory and is not tracked.
 *
 * Usage:
 *   node scripts/render-check/theme-css.mjs            # write the staged file
 *   node scripts/render-check/theme-css.mjs --print    # dump it to stdout
 *
 * @module scripts/render-check/theme-css
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = resolve(HERE, '..', '..')
const WORK = join(REPO, '.render-check')

/**
 * Where the installed theme package keeps its client bundle.
 *
 * Searched rather than hard-coded: the DSH CLI is installed per Node version
 * under nvm here, and a global install would put it somewhere else entirely.
 */
const CANDIDATES = [
  process.env.DSH_THEME_BUNDLE,
  join(process.env.DSH_NODE_ROOT ?? '', 'lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-client-ui-theme/lib/client.js'),
  '/home/eushing/.nvm/versions/node/v24.16.0/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-client-ui-theme/lib/client.js',
].filter((p) => p !== undefined && p !== '')

/** The CSS literals to lift, in the order the package registers them.
 *
 * `gradient_shadow_text_css_default` is the one that carries the whole
 * elevation family (`--dsw-elevation-stroke`, `-soft`, `-panel`, `-prominent`)
 * and the elevation stroke colour's own default. Leaving it out is not a
 * cosmetic omission: the composer card draws its edge from `elevation-soft`,
 * so without it the card and the composer both computed `box-shadow: none` and
 * the "these two do not share an edge" assertion compared two absent shadows —
 * passing or failing for reasons that had nothing to do with the card. */
const WANTED = [
  'base_css_default',
  'corner_shape_css_default',
  'design_platform_css_default',
  'gradient_shadow_text_css_default',
  'focus_css_default',
  'scrollbar_css_default',
]

/** The bundle this repo should read the theme from, or undefined. */
function findBundle() {
  for (const c of CANDIDATES) if (existsSync(c)) return c
  return undefined
}

/**
 * Pull one `name = "…"` CSS literal out of the bundle.
 *
 * The literals are ordinary double-quoted JS strings, so the escape that
 * matters is `\"`; everything else in them is CSS and is left alone.
 */
function literal(source, name) {
  const m = source.match(new RegExp(`${name} = "((?:[^"\\\\]|\\\\.)*)"`))
  if (m === null) return undefined
  return m[1].replace(/\\"/g, '"').replace(/\\n/g, '\n')
}

function build() {
  const bundle = findBundle()
  if (bundle === undefined) {
    return { error: `no theme bundle found. Looked in:\n  ${CANDIDATES.join('\n  ')}\n`
      + 'Set DSH_THEME_BUNDLE to the package\'s lib/client.js.' }
  }
  const source = readFileSync(bundle, 'utf8')
  const parts = []
  const missing = []
  for (const name of WANTED) {
    const css = literal(source, name)
    if (css === undefined) missing.push(name)
    else parts.push(`/* ${name} */\n${css}`)
  }
  if (parts.length === 0) return { error: `found ${bundle} but read no CSS out of it` }
  return { css: parts.join('\n\n'), bundle, missing }
}

const result = build()
if (result.error !== undefined) {
  console.error(`theme-css: ${result.error}`)
  process.exit(1)
}

const header = `/* GENERATED by scripts/render-check/theme-css.mjs — do not edit.
 * Lifted verbatim from ${result.bundle}
 * so the preview and the render check paint the real palette.
 * Regenerate with: node scripts/render-check/theme-css.mjs
 */
`

if (process.argv.includes('--print')) {
  process.stdout.write(header + result.css)
} else {
  mkdirSync(WORK, { recursive: true })
  writeFileSync(join(WORK, 'theme.css'), header + result.css)
  console.log(`theme-css: wrote ${join(WORK, 'theme.css')} (${result.css.length} bytes)`)
  if (result.missing.length > 0) {
    console.log(`theme-css: note — not present in this build: ${result.missing.join(', ')}`)
  }
}