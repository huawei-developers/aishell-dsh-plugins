#!/usr/bin/env node
/**
 * Add a DSH release to the compatibility range every package declares.
 *
 * ## Why this is a script
 *
 * Each plugin package lists the `@deepseek-ai/dsh-*` versions it has been vetted
 * against, as an explicit `A || B || C` enumeration in every dependency block
 * it uses — `peerDependencies`, `devDependencies`, and `dependencies` for the
 * packages that ship a DSH package on the Node half. That is the right shape —
 * npm cannot express "any prerelease of 0.2.x", and an open range would let an
 * unvetted build install silently — but it means one new release has to be
 * written into every manifest, in every dependency block that names a `dsh-*`
 * package.
 *
 * That enumeration is also what the profile loader reads: a bundle whose
 * declared ranges do not name the running DSH version is skipped whole and
 * listed in `skippedBundles`, so a stale range makes the aggregate bundle
 * disappear from a profile rather than fail in it. The enumeration is a
 * load-bearing input, not a description.
 *
 * Doing that by hand is how a range ends up inconsistent between packages: one
 * of them keeps an old entry, and the plugin that needed upgrading is the one
 * that refuses to install next to the new host.
 *
 * ## Two ways to bring a release in
 *
 * By default the new release is **appended**, keeping every version already
 * listed: the line stays compatible with the older hosts it was vetted on.
 *
 * With `--replace` every range becomes exactly the new release. That is the
 * right move when the older hosts are being dropped rather than continued —
 * the same narrowing a previous alignment made when it removed the 0.2.0 and
 * 0.2.1 tails after their cordis requirement stopped matching. Both are one
 * run over the whole workspace, so no package is left half-migrated.
 *
 * ## What it guarantees
 *
 * - **All or nothing.** Every manifest is read and every range planned before
 *   any file is written, so a malformed manifest or a non-string range leaves
 *   the tree untouched instead of half-migrated.
 * - **Verified afterwards.** The written files are read back and checked, so a
 *   range the write missed fails the run instead of shipping.
 * - **Append keeps order.** Ranges are appended to, never re-sorted: the order
 *   records what was vetted when. A release that sorts before the current tail
 *   still appends, and is reported, because a range that reads out of order
 *   invites the next reader to "fix" it into a different set.
 * - **A bundle with no `dsh-*` peer is reported.** The range list is what the
 *   profile loader checks before it loads a bundle, so a bundle that declares
 *   no `dsh-*` requirement passes that check on every host version, vetted or
 *   not. This is a warning rather than a failure: adding a peer is a manifest
 *   change with its own consequences, and it belongs to the package that owns
 *   the requirement.
 *
 * ## What it does not do
 *
 * It does not run `pnpm install`. The lockfile records the ranges, so an
 * install has to follow — but that is a separate, visible step rather than a
 * side effect, because it rewrites `pnpm-lock.yaml` and takes tens of seconds.
 * It also does not check that the release exists on npm: this script records a
 * vetting decision a person already made, and a network read here would make
 * the record depend on whether that read happened to succeed.
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

/**
 * The dependency fields a range appears in.
 *
 * `dependencies` is included because some plugins ship a DSH package on the
 * Node half — `dsh-client-store` is a real runtime dependency of the
 * credentials and share packages — so a release added only to the peer and dev
 * blocks would leave those two behind. pnpm resolves each importer from its own
 * field, so a stale range there pins that importer to the old release while the
 * rest of the workspace moves.
 */
const FIELDS = ['dependencies', 'peerDependencies', 'devDependencies']

/** Every package whose declared ranges this line is vetted through. */
const RANGE_PREFIX = '@deepseek-ai/dsh-'

/** Releases this script accepts: an exact version, prerelease included. */
const RELEASE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/

const args = process.argv.slice(2)
const dryRun = args.includes('--dry-run')
/** Replace every range instead of appending to it; the older hosts are being dropped. */
const replace = args.includes('--replace')
const version = args.find(arg => !arg.startsWith('--'))
if (version === undefined || !RELEASE.test(version)) {
  console.error('[vet] usage: node scripts/vet-dsh-release.mjs <version> [--replace] [--dry-run]')
  console.error('[vet]   e.g. node scripts/vet-dsh-release.mjs 0.2.2-rc.1')
  console.error('[vet]   --replace  make the new release the only one listed, dropping the older ones')
  process.exit(1)
}

/**
 * Compare two exact versions the way a semver range reader would.
 *
 * Only the ordering this script reports on is needed, so prerelease identifiers
 * follow semver's own rule — numeric ones compare numerically and rank below
 * alphanumeric ones — without pulling in a parser for the rest of the grammar.
 *
 * @param left - an exact version.
 * @param right - an exact version.
 * @returns a negative number, zero, or a positive number as left sorts below,
 *   equal to, or above right.
 */
function compareVersions(left, right) {
  const [leftCore, leftPre] = splitPrerelease(left)
  const [rightCore, rightPre] = splitPrerelease(right)
  for (let index = 0; index < 3; index += 1) {
    const difference = Number(leftCore[index] ?? 0) - Number(rightCore[index] ?? 0)
    if (difference !== 0) return difference
  }
  if (leftPre === undefined || rightPre === undefined) {
    // A release sorts above every prerelease of the same core version.
    return leftPre === rightPre ? 0 : leftPre === undefined ? 1 : -1
  }
  for (let index = 0; index < Math.max(leftPre.length, rightPre.length); index += 1) {
    const one = leftPre[index]
    const two = rightPre[index]
    if (one === undefined) return -1
    if (two === undefined) return 1
    if (one === two) continue
    const oneNumeric = /^\d+$/.test(one)
    const twoNumeric = /^\d+$/.test(two)
    if (oneNumeric && twoNumeric) return Number(one) - Number(two)
    if (oneNumeric !== twoNumeric) return oneNumeric ? -1 : 1
    return one < two ? -1 : 1
  }
  return 0
}

/** Split `1.2.3-alpha.1` into its numeric core and its prerelease identifiers. */
function splitPrerelease(value) {
  const dash = value.indexOf('-')
  const core = dash === -1 ? value : value.slice(0, dash)
  const prerelease = dash === -1 ? undefined : value.slice(dash + 1).split('.')
  return [core.split('.'), prerelease]
}

/** One range this run would extend. */
const changes = []
/** Ranges this run leaves alone because they already name the release. */
let alreadyThere = 0
/** Package directories with no dsh range at all; not this script's business. */
let untouched = 0
/** Files that could not be read as a manifest; a broken one must not be skipped silently. */
const unreadable = []

for (const dir of readdirSync(PACKAGES).sort()) {
  const path = join(PACKAGES, dir, 'package.json')
  let manifest
  try {
    manifest = JSON.parse(readFileSync(path, 'utf8'))
  } catch (error) {
    // A directory without a manifest is not a package; a package whose
    // manifest will not parse is a defect this run must not paper over.
    if (error.code === 'ENOENT') continue
    unreadable.push(`${relative(ROOT, path)}: ${String(error.message)}`)
    continue
  }

  let sawRange = false
  for (const field of FIELDS) {
    const block = manifest[field]
    if (block === undefined) continue
    for (const [name, range] of Object.entries(block)) {
      if (!name.startsWith(RANGE_PREFIX)) continue
      sawRange = true
      if (typeof range !== 'string') {
        unreadable.push(`${relative(ROOT, path)}: ${field}[${JSON.stringify(name)}] is not a string`)
        continue
      }
      const parts = range.split('||').map(part => part.trim())
      // Under --replace every range is rewritten even when it already names the
      // release: the point of that mode is that no older entry survives.
      if (!replace && parts.includes(version)) {
        alreadyThere += 1
        continue
      }
      if (replace && parts.length === 1 && parts[0] === version) {
        alreadyThere += 1
        continue
      }
      changes.push({ path, field, name, parts, range: range.trim() })
    }
  }
  if (!sawRange) untouched += 1
}

/**
 * Bundles the loader's compatibility check cannot refuse.
 *
 * That check reads `engines.dsh` when the manifest has one, and otherwise the
 * `@deepseek-ai/dsh-*` entries of `peerDependencies` — a range in `dependencies`
 * pins what pnpm installs and does not gate loading. So a bundle with neither
 * loads on every host version, including one this line has never been vetted on.
 *
 * Only bundles are named: a package without a bundle patch is reached through
 * the bundle that declares it, and that bundle carries the check.
 */
const ungated = []
for (const dir of readdirSync(PACKAGES).sort()) {
  const path = join(PACKAGES, dir, 'package.json')
  let manifest
  try {
    manifest = JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    continue
  }
  if (manifest.dsh?.bundle === undefined) continue
  if (manifest.engines?.dsh !== undefined) continue
  const gated = Object.keys(manifest.peerDependencies ?? {}).some(name => name.startsWith(RANGE_PREFIX))
  if (!gated) ungated.push(relative(ROOT, path))
}

if (unreadable.length > 0) {
  for (const line of unreadable) console.error(`[vet] cannot read ${line}`)
  console.error('\n[vet] nothing written — fix the manifests above and run again')
  process.exit(1)
}

/**
 * Ranges grouped by the exact enumeration they declare.
 *
 * Packages are vetted against one host line, so they are expected to declare
 * the same set; a group of one is how a package that was missed last time
 * looks, and naming it is what makes the miss visible before it ships.
 */
const shapes = new Map()
for (const { parts, name, field } of changes) {
  const key = parts.join(' || ')
  if (!shapes.has(key)) shapes.set(key, [])
  shapes.get(key).push(`${name} (${field})`)
}

const behindTail = replace
  ? []
  : changes.filter(({ parts }) => {
    const tail = parts.at(-1)
    return tail !== undefined && /^\d+\.\d+\.\d+/.test(tail) && compareVersions(version, tail) < 0
  })

for (const { path, field, name, range } of changes) {
  const next = replace ? version : `${range} || ${version}`
  if (dryRun) {
    console.log(`[vet] would set ${relative(ROOT, path)} ${field}[${JSON.stringify(name)}] -> ${next}`)
    continue
  }
  const manifest = JSON.parse(readFileSync(path, 'utf8'))
  manifest[field][name] = next
  writeFileSync(path, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
  console.log(`[vet] ${relative(ROOT, path)}`)
}

// Verification: the point of the run is that every range was covered, so the
// result is read back rather than inferred from the plan. Append checks
// membership, because a range that already named the release keeps the position
// it had; replace checks equality, because the point of that mode is that the
// new release is the only one left. A dry run skips it: no file was written, so
// the ranges on disk still say what they said before.
const late = []
for (const dir of readdirSync(PACKAGES).sort()) {
  const path = join(PACKAGES, dir, 'package.json')
  let manifest
  try {
    manifest = JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    continue
  }
  for (const field of FIELDS) {
    for (const [name, range] of Object.entries(manifest[field] ?? {})) {
      if (!name.startsWith(RANGE_PREFIX) || typeof range !== 'string') continue
      const parts = range.split('||').map(part => part.trim())
      const covered = replace ? parts.length === 1 && parts[0] === version : parts.includes(version)
      if (!covered) late.push(`${relative(ROOT, path)} ${field}[${JSON.stringify(name)}] -> ${range}`)
    }
  }
}

// The reports below describe the tree, not the run, so a dry run prints them
// too: they are the findings a person wants *before* writing the manifests.
console.log(
  `${dryRun ? 'dry run — ' : ''}[vet] ${replace ? 'replaced' : 'extended'} ${changes.length} range(s) with ${version}`
  + (alreadyThere > 0 ? `, ${alreadyThere} already listed it` : '')
  + (untouched > 0 ? `, ${untouched} package(s) had no dsh range` : ''),
)

if (shapes.size > 1) {
  console.log(`\n[vet] ${shapes.size} distinct range shapes were ${replace ? 'replaced' : 'extended'}; each now names ${version}:`)
  for (const [shape, owners] of shapes) console.log(`[vet]   ${shape}\n[vet]     ${owners.join(', ')}`)
}

if (behindTail.length > 0) {
  console.log(`\n[vet] ${version} sorts before the tail it was appended to, so these read out of order:`)
  for (const { path, field, name } of behindTail) console.log(`[vet]   ${relative(ROOT, path)} ${field}[${JSON.stringify(name)}]`)
  console.log('[vet] npm reads a union range in any order; the order records vetting history, so it is left as written.')
}

if (ungated.length > 0) {
  console.log(`\n[vet] ${ungated.length} bundle(s) declare no ${RANGE_PREFIX}* range, so the loader loads them on any host version:`)
  for (const path of ungated) console.log(`[vet]   ${path}`)
  console.log('[vet] adding a requirement is a manifest change; it belongs to the package that owns it.')
}

if (dryRun) {
  console.log('\n[vet] dry run — nothing written')
  process.exit(0)
}

if (late.length > 0) {
  console.error(`\n[vet] ${late.length} range(s) do not name ${version}:`)
  for (const line of late) console.error(`[vet]   ${line}`)
  console.error('[vet] the tree is written; inspect the ranges above by hand')
  process.exit(1)
}

if (changes.length > 0) {
  console.log('\nNext:\n  pnpm install    # the lockfile records the ranges\n  pnpm run typecheck')
}
