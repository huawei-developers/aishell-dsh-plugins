#!/usr/bin/env node
/**
 * Aggregate plugin generator for the aishell-dsh-plugins monorepo.
 *
 * An aggregate bundle is a carrier package whose cordis.patch.yml is the
 * concatenation of its child plugins' insert rows and whose package.json
 * dependencies pull in every child with "workspace:*". The DSH loader
 * resolves patch rows from the profile root, so the children are installed as
 * normal dependencies (pnpm hoists them in the default layout).
 *
 * Simplified from dsh-web's scripts/aggregate.mjs — no shell fault-isolation,
 * no client-children mirror, no subpath exports (aishell has 3 packages, not 20).
 *
 * Usage:
 *   node scripts/aggregate.mjs                     # regenerate + write
 *   node scripts/aggregate.mjs --check             # verify only; exit 1 on drift
 *   node scripts/aggregate.mjs --root <dir>        # treat <dir> as the repo root
 *
 * Each aggregate package carries a hand-written aggregate.yml:
 *   patchFrom:   child dirs whose cordis.patch.yml insert rows are merged
 *   deps:        child dirs written into package.json dependencies as workspace:*
 *   disable:     id-targeted upstream rows switched off in the composed profile
 *   override:    id-targeted upstream rows whose whole config this layer replaces
 */
import {
  existsSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join, relative, resolve as resolvePath } from 'node:path'
import { fileURLToPath } from 'node:url'

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url))
/** Optional repo-root override: `--root <dir>` or `--root=<dir>`; tests drive the generator against a fixture tree. */
const ROOT_INDEX = process.argv.indexOf('--root')
const ROOT_EQUALS = process.argv.find(arg => arg.startsWith('--root='))
const REPO_ROOT = ROOT_EQUALS !== undefined
  ? resolvePath(process.cwd(), ROOT_EQUALS.slice('--root='.length))
  : ROOT_INDEX !== -1 && process.argv[ROOT_INDEX + 1] !== undefined
    ? resolvePath(process.cwd(), process.argv[ROOT_INDEX + 1])
    : resolvePath(SCRIPT_DIR, '..')
const CHECK = process.argv.includes('--check')

/** Namespace one child row id for the aggregate patch (avoid duplicate-entry with standalone installs). */
function namespaceId(id) {
  if (id.startsWith('aishell-')) return id
  return `aishell-${id.replace(/^(aishell-)+/, '')}`
}

/** Parse aggregate.yml — a YAML subset (key: sections, - list entries, # comments). */
function parseManifest(ymlPath) {
  const manifest = { patchFrom: [], deps: [], disable: [], override: [] }
  let section = null
  for (const raw of readFileSync(ymlPath, 'utf8').split(/\r?\n/)) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    const sectionMatch = line.match(/^([A-Za-z0-9_-]+):\s*$/)
    if (sectionMatch) {
      section = sectionMatch[1]
      continue
    }
    if (!(section in manifest)) { section = null; continue }
    const entryMatch = line.match(/^-\s+(.+)$/)
    if (!entryMatch) continue
    const entry = entryMatch[1].trim().replace(/\s+#.*$/, '')
    if (section === 'patchFrom') manifest.patchFrom.push(entry)
    else if (section === 'deps') manifest.deps.push(entry)
    else if (section === 'disable') manifest.disable.push(entry)
    else if (section === 'override') manifest.override.push(entry)
  }
  return manifest
}

/**
 * Parse a child's cordis.patch.yml into insert row blocks.
 * Only handles `- insert:` blocks with `id:` + `name:` + optional `config:`.
 */
function parsePatchBlocks(patchPath) {
  const lines = readFileSync(patchPath, 'utf8').split(/\r?\n/)
  const blocks = []
  let inInsert = false
  for (let i = 0; i < lines.length; i++) {
    const text = lines[i].trimEnd()
    if (/^- insert:\s*$/.test(text.trim())) { inInsert = true; continue }
    const idMatch = text.match(/^(\s*)- id:\s*(\S+)\s*$/)
    if (!idMatch) continue
    const indent = idMatch[1].length
    if (indent === 0) { inInsert = false; continue }
    if (!inInsert) continue
    const block = { id: idMatch[2], name: '', configLines: [] }
    const subIndent = indent + 2
    let j = i + 1
    const nameLine = lines[j]
    if (nameLine && nameLine.startsWith(' '.repeat(subIndent)) && nameLine.slice(subIndent).startsWith('name:')) {
      const m = nameLine.slice(subIndent).match(/^name:\s*['"]([^'"]+)['"]\s*$/) || nameLine.slice(subIndent).match(/^name:\s*(\S+)\s*$/)
      if (m) { block.name = m[1]; j++ }
    }
    while (j < lines.length) {
      const candidate = lines[j]
      const cIndent = candidate.length - candidate.trimStart().length
      if (cIndent <= indent) break
      if (cIndent <= subIndent && candidate.slice(subIndent).startsWith('config:')) {
        j++
        while (j < lines.length) {
          const nested = lines[j]
          const nIndent = nested.length - nested.trimStart().length
          if (nIndent <= subIndent) break
          block.configLines.push(nested)
          j++
        }
        continue
      }
      if (cIndent <= subIndent) break
      j++
    }
    if (block.name) blocks.push(block)
    i = j - 1
  }
  return blocks
}

function pushConfig(lines, configLines, keyIndent) {
  if (configLines.length === 0) return
  lines.push(`${' '.repeat(keyIndent)}config:`)
  for (const line of configLines) lines.push(line)
}

/**
 * Parse one `override` manifest entry: `<row-id>: <inline YAML mapping>` —
 * the config an id-targeted row in an earlier (official) layer should carry
 * instead of its own. Rendered as an id-targeted patch row with that config.
 */
function parseOverride(entry) {
  const m = entry.match(/^([A-Za-z0-9_-]+):\s*(.+)$/)
  if (!m) {
    console.error(`[aggregate] ERROR override entry is not "<row-id>: <yaml>": ${entry}`)
    process.exit(1)
  }
  return { id: m[1], configYaml: m[2].trim() }
}

/** Render the aggregate cordis.patch.yml. */
function renderPatch(blocks, rel, disable = [], override = []) {
  const lines = [
    '# AUTO-GENERATED by scripts/aggregate.mjs — do not edit',
    '# This file is derived from the aggregate.yml manifest in this package.',
    '# Edit aggregate.yml and rerun `node scripts/aggregate.mjs`.',
    '# Rows are namespaced aishell-* so the bundle can coexist with standalone installs.',
  ]
  const seen = new Set()
  for (const { entry, rows } of blocks) {
    if (rows.length === 0) continue
    lines.push('', `# from ${entry}`)
    lines.push('- insert:')
    for (const row of rows) {
      const id = namespaceId(row.id)
      if (seen.has(id)) { console.error(`[aggregate] ERROR ${rel}: duplicate row id ${id}`); process.exit(1) }
      seen.add(id)
      lines.push(`    - id: ${id}`)
      lines.push(`      name: '${row.name}'`)
      pushConfig(lines, row.configLines, 6)
    }
  }
  // id-targeted config overrides: the bundle layer applies after the official
  // bundles, so these replace an upstream row's whole config (patch semantics:
  // a row's config is replaced, not merged — state the complete value). The
  // manifest entry already carries the full YAML mapping; braces included, so
  // it is emitted verbatim.
  if (override.length > 0) {
    lines.push('', '# overridden upstream rows (id-targeted; this layer applies after the official bundles)')
    for (const { id, configYaml } of override.map(parseOverride)) {
      if (seen.has(namespaceId(id))) { console.error(`[aggregate] ERROR ${rel}: override id collides with an inserted row: ${id}`); process.exit(1) }
      seen.add(id)
      lines.push(`- id: ${id}`)
      lines.push(`  config: ${configYaml}`)
    }
  }
  // id-targeted disable rows: the bundle layer applies after the official
  // bundles, so these switch off upstream rows in the composed profile.
  if (disable.length > 0) {
    lines.push('', '# disabled upstream rows (id-targeted; this layer applies after the official bundles)')
    for (const id of disable) {
      if (seen.has(namespaceId(id))) { console.error(`[aggregate] ERROR ${rel}: disable id collides with an inserted row: ${id}`); process.exit(1) }
      seen.add(id)
      lines.push(`- id: ${id}`)
      lines.push('  disabled: true')
    }
  }
  return lines.join('\n') + '\n'
}

/** Resolve manifest entries to their package names. */
function resolveEntries(pkgDir, entries, section) {
  const resolved = []
  for (const entry of entries) {
    const depDir = resolvePath(pkgDir, entry)
    const pkgPath = join(depDir, 'package.json')
    if (!existsSync(pkgPath)) {
      console.error(`[aggregate] ERROR ${section} target has no package.json: ${entry} (${pkgPath})`)
      process.exit(1)
    }
    const manifest = JSON.parse(readFileSync(pkgPath, 'utf8'))
    if (!manifest.name) {
      console.error(`[aggregate] ERROR no "name" in ${pkgPath}`)
      process.exit(1)
    }
    resolved.push({ name: manifest.name, entry })
  }
  return resolved
}

/** Rebuild package.json dependencies from manifest deps. */
function renderPackageJson(pkgPath, resolvedDeps) {
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'))
  const next = {}
  for (const { name } of resolvedDeps) next[name] = 'workspace:*'
  for (const key of Object.keys(pkg.dependencies ?? {}).filter(k => !(k in next)).sort()) {
    next[key] = pkg.dependencies[key]
  }
  if (Object.keys(next).length) pkg.dependencies = next
  else delete pkg.dependencies
  return JSON.stringify(pkg, null, 2) + '\n'
}

/** Find aggregate packages: any dir with aggregate.yml under packages/. */
function findAggregates() {
  const packagesDir = join(REPO_ROOT, 'packages')
  if (!existsSync(packagesDir)) return []
  return readdirSync(packagesDir)
    .filter(name => statSync(join(packagesDir, name)).isDirectory())
    .map(name => join(packagesDir, name))
    .filter(dir => existsSync(join(dir, 'aggregate.yml')))
    .map(dir => ({ pkgDir: dir, ymlPath: join(dir, 'aggregate.yml') }))
}

console.log(`[aggregate] scanning ${join(REPO_ROOT, 'packages')} for aggregate.yml...`)
const aggregates = findAggregates()
if (aggregates.length === 0) {
  console.log('[aggregate] no aggregate.yml found; nothing to do.')
  process.exit(0)
}

const errors = []
const results = []
for (const { pkgDir, ymlPath } of aggregates) {
  const rel = relative(REPO_ROOT, pkgDir)
  const manifest = parseManifest(ymlPath)
  const blocks = []
  for (const entry of manifest.patchFrom) {
    const target = resolvePath(pkgDir, entry)
    if (!existsSync(target)) {
      errors.push(`patchFrom target not found: ${ymlPath} -> ${entry}`)
      continue
    }
    const patchPath = join(target, 'cordis.patch.yml')
    if (!existsSync(patchPath)) {
      errors.push(`patchFrom target has no cordis.patch.yml: ${target}`)
      continue
    }
    const rows = parsePatchBlocks(patchPath)
    blocks.push({ entry, rows })
  }
  if (manifest.patchFrom.length === 0) {
    console.log(`[aggregate] WARN ${rel}: no patchFrom entries`)
  }
  const patch = renderPatch(blocks, rel, manifest.disable, manifest.override)
  const resolvedDeps = resolveEntries(pkgDir, manifest.deps, 'deps')
  const pkgJson = renderPackageJson(join(pkgDir, 'package.json'), resolvedDeps)
  results.push({ rel, patch, resolvedDeps, pkgJson })
}

if (errors.length) {
  for (const e of errors) console.error(`[aggregate] ERROR ${e}`)
  process.exit(1)
}

let failed = false
for (const r of results) {
  const patchPath = join(REPO_ROOT, r.rel, 'cordis.patch.yml')
  const pkgPath = join(REPO_ROOT, r.rel, 'package.json')
  if (CHECK) {
    const diffs = []
    if (!existsSync(patchPath) || readFileSync(patchPath, 'utf8') !== r.patch) diffs.push(relative(REPO_ROOT, patchPath))
    if (!existsSync(pkgPath) || readFileSync(pkgPath, 'utf8') !== r.pkgJson) diffs.push(relative(REPO_ROOT, pkgPath))
    if (diffs.length) {
      for (const d of diffs) console.log(`[aggregate] check: ${d} differs`)
      failed = true
    } else {
      console.log(`[aggregate] check OK: ${r.rel} (${r.resolvedDeps.length} dep(s))`)
    }
  } else {
    writeFileSync(patchPath, r.patch)
    console.log(`[aggregate] wrote ${relative(REPO_ROOT, patchPath)}`)
    writeFileSync(pkgPath, r.pkgJson)
    console.log(`[aggregate] wrote ${relative(REPO_ROOT, pkgPath)} (${r.resolvedDeps.length} workspace dep(s))`)
  }
}

if (failed) {
  console.error('[aggregate] check FAILED')
  process.exit(1)
}
console.log('[aggregate] done')
