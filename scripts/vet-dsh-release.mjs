#!/usr/bin/env node
/**
 * Add a DSH release to the compatibility range every package declares.
 *
 * ## Why this is a script
 *
 * Each plugin package lists the `@deepseek-ai/dsh-*` versions it has been vetted
 * against, as an explicit `A || B || C` enumeration in both `peerDependencies`
 * and `devDependencies`. That is the right shape — npm cannot express "any
 * prerelease of 0.2.x", and an open range would let an unvetted build install
 * silently — but it means one new release has to be appended in eight manifests
 * across two dependency blocks each, for every `dsh-*` package.
 *
 * Doing that by hand is how a range ends up inconsistent between packages: one
 * of them keeps the old tail, and the plugin that needed upgrading is the one
 * that refuses to install next to the new host. This script rewrites every
 * occurrence at once, or reports the files it could not find the tail in.
 *
 * ## What it does not do
 *
 * It does not run `pnpm install`. The lockfile records the ranges, so an
 * install has to follow — but that is a separate, visible step rather than a
 * side effect, because it rewrites `pnpm-lock.yaml` and takes tens of seconds.
 *
 * @module scripts/vet-dsh-release
 */

import { readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

/** Repository root, derived from this file so the script runs from anywhere. */
const ROOT = fileURLToPath(new URL('..', import.meta.url))

/** The packages whose manifests carry the range. */
const PACKAGES = join(ROOT, 'packages')

/** The dependency fields a range appears in. */
const FIELDS = ['peerDependencies', 'devDependencies']

const version = process.argv[2]
if (version === undefined || !/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(version)) {
  console.error('[vet] usage: node scripts/vet-dsh-release.mjs <version>')
  console.error('[vet]   e.g. node scripts/vet-dsh-release.mjs 0.2.2-rc.1')
  process.exit(1)
}

let extended = 0
let alreadyThere = 0
let untouched = 0

for (const dir of readdirSync(PACKAGES).sort()) {
  const path = join(PACKAGES, dir, 'package.json')
  let manifest
  try {
    manifest = JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    // No manifest, or not JSON — not a package this script is about.
    continue
  }

  let touched = false
  for (const field of FIELDS) {
    const block = manifest[field]
    if (block === undefined) continue
    for (const [name, range] of Object.entries(block)) {
      if (!name.startsWith('@deepseek-ai/dsh-')) continue
      if (typeof range !== 'string') continue
      if (range.split('||').some(part => part.trim() === version)) {
        alreadyThere += 1
        continue
      }
      // Append rather than rewrite: the order records what was vetted when, and
      // a resorted range would lose that.
      block[name] = `${range.trim()} || ${version}`
      touched = true
      extended += 1
    }
  }

  if (touched) {
    writeFileSync(path, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
    console.log(`[vet] ${relative(ROOT, path)}`)
  } else {
    untouched += 1
  }
}

console.log(
  `\n[vet] extended ${extended} range(s) to include ${version}`
  + (alreadyThere > 0 ? `, ${alreadyThere} already listed it` : '')
  + (untouched > 0 ? `, ${untouched} package(s) had no dsh range` : ''),
)
if (extended > 0) {
  console.log('\nNext:\n  pnpm install    # the lockfile records the ranges\n  pnpm run typecheck')
}