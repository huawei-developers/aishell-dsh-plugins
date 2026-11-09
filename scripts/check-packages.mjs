#!/usr/bin/env node
/**
 * Packaging contract check for the publishable plugin packages.
 *
 * Every manifest here promises things about files that do not exist until the
 * package is packed: `types`, each `exports` subpath's `types`, every `files`
 * entry, and `dsh.bundle.patch`. Nothing verifies those promises during normal
 * development, because the loader only ever reads `lib/index.js` and
 * `lib/client.js` — a manifest pointing at a declaration file that is never
 * shipped breaks nobody locally and breaks every consumer of the published
 * package. That is exactly the defect this script exists for: the whole
 * `lib/types/` tree was being deleted by tsdown's `clean` after `tsc -b` wrote
 * it, so four packages published with no types at all while every local check
 * stayed green.
 *
 * It packs each package with `pnpm pack` and reads the tarball, so it tests the
 * artifact rather than the directory. That matters: `files`-based inclusion,
 * `publishConfig`, and the `workspace:*` version rewrite all happen at pack
 * time, and a check against the working tree would miss every one of them.
 *
 * `pnpm pack` needs no registry, no token and no network, so this runs in CI.
 *
 * Usage:
 *   node scripts/check-packages.mjs            # verify; exit 1 on any failure
 *   node scripts/check-packages.mjs --prepublish   # also assert the packer
 *
 * A package opts out with `"dsh": { "publishCheck": false }`; the aggregate
 * bundle is excluded by default because it ships only a patch, not artifacts.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { readdirSync, statSync } from 'node:fs'

const REPO_ROOT = resolve(import.meta.dirname, '..')
const PACKAGES_DIR = join(REPO_ROOT, 'packages')
const PREPUBLISH = process.argv.includes('--prepublish')

/**
 * Refuse to publish from a packer that would ship an uninstallable artifact.
 *
 * Only pnpm rewrites the `workspace:` protocol at pack time. `npm publish` does
 * not, so every internal dependency would go to the registry verbatim as
 * `workspace:*` and nobody could install the result (`EUNSUPPORTEDPROTOCOL`).
 * The tarball check below catches that, but here it can say why and which
 * command to use instead — and it runs as a package's `prepublishOnly`, which
 * is the last moment before an irreversible publish.
 */
if (PREPUBLISH) {
  const agent = process.env.npm_config_user_agent ?? ''
  if (!agent.startsWith('pnpm/')) {
    console.error(
      '[check-packages] refusing to publish: this must run under pnpm.\n' +
        '  The internal dependencies use the `workspace:` protocol, which only\n' +
        '  pnpm rewrites to a real version at pack time. Publishing with npm\n' +
        '  would ship `workspace:*` verbatim and the packages would be\n' +
        '  uninstallable. Use: pnpm -r publish --tag beta --publish-branch main',
    )
    process.exit(1)
  }
}

/**
 * Pack one package and read the tarball.
 *
 * `pnpm pack` on purpose. It is the only packer that rewrites the
 * `workspace:` protocol into the real version at pack time — and every
 * internal dependency here uses that protocol, because a literal version
 * cannot resolve in the workspace before the dependency is first published.
 * `npm pack` leaves `workspace:*` verbatim, and a tarball carrying it is
 * uninstallable (`EUNSUPPORTEDPROTOCOL`), so a tarball produced by npm is
 * never the artifact this project ships.
 *
 * Read the other way round, that makes this check the guard against
 * publishing the wrong way: run it after `npm pack` and the `workspace:`
 * assertion below fails on every internal edge (8 of them, measured), naming
 * the cause. Publishing must go through `pnpm publish` (see `publish:beta`).
 */
function packAndRead(pkgDir, dest) {
  execFileSync('pnpm', ['pack', '--pack-destination', dest], {
    cwd: pkgDir,
    stdio: ['ignore', 'ignore', 'pipe'],
  })
  const tarball = readdirSync(dest).find(name => name.endsWith('.tgz'))
  if (tarball === undefined) throw new Error(`pnpm pack produced no tarball in ${dest}`)
  const entries = execFileSync('tar', ['-tzf', join(dest, tarball)], { encoding: 'utf8' })
    .split('\n')
    .filter(line => line.startsWith('package/'))
    .map(line => line.slice('package/'.length))
    .filter(line => line.length > 0)
  const manifest = JSON.parse(
    execFileSync('tar', ['-xzOf', join(dest, tarball), 'package/package.json'], { encoding: 'utf8' }),
  )
  return { tarball, entries, manifest }
}

/** Whether one shipped path (possibly a glob) matches a tarball entry. */
function shipped(entries, declared) {
  const path = declared.replace(/^\.\//, '')
  if (!path.includes('*')) return entries.includes(path)
  // The manifests use only `*` (within a segment) and `**/` (across segments),
  // so translate just those two rather than pulling in a glob dependency.
  const pattern = path
    .split('**/')
    .map(part => part.split('*').map(escapeRegExp).join('[^/]*'))
    .join('(?:.*/)?')
  const matches = new RegExp(`^${pattern}$`)
  return entries.some(entry => matches.test(entry))
}

/** Escape the regex metacharacters a file path may contain. */
function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** Every path a manifest promises to ship, with where the promise came from. */
function promisedPaths(manifest, declaredFiles) {
  const promises = []
  if (typeof manifest.types === 'string') {
    promises.push({ path: manifest.types, source: 'types' })
  }
  for (const [subpath, target] of Object.entries(manifest.exports ?? {})) {
    if (target === null || typeof target !== 'object') continue
    // `./src/*` is a deliberate convention across every DSH package: it maps to
    // source that is intentionally not published, for host-side tooling only.
    if (subpath === './src/*') continue
    if (typeof target.types === 'string') {
      promises.push({ path: target.types, source: `exports["${subpath}"].types` })
    }
    if (typeof target.default === 'string') {
      promises.push({ path: target.default, source: `exports["${subpath}"].default` })
    }
  }
  for (const entry of declaredFiles) {
    promises.push({ path: entry, source: 'files' })
  }
  const patch = manifest.dsh?.bundle?.patch
  for (const file of typeof patch === 'string' ? [patch] : patch ?? []) {
    promises.push({ path: file, source: 'dsh.bundle.patch' })
  }
  return promises
}

const failures = []
const checked = []
/** Packages with at least one failure, for the summary. */
const failedNames = new Set()

/**
 * Restrict the run to one package directory.
 *
 * The packages wire this script as their own `prepublishOnly`, and a publish
 * invokes that hook once per package. Without a restriction each of those six
 * invocations would re-pack all six packages — about 28 seconds of repeated
 * identical work, and output that reads the same six times while publishing
 * one. Naming the directory (not the package name, which the caller would have
 * to read out of the manifest first) keeps the hook a one-liner.
 */
const ONLY = (() => {
  const flag = process.argv.indexOf('--only')
  return flag === -1 ? undefined : process.argv[flag + 1]
})()
if (ONLY !== undefined && !existsSync(join(PACKAGES_DIR, ONLY))) {
  console.error(`[check-packages] --only ${ONLY}: no such package directory under packages/`)
  process.exit(1)
}

for (const name of readdirSync(PACKAGES_DIR).sort()) {
  if (ONLY !== undefined && name !== ONLY) continue
  const pkgDir = join(PACKAGES_DIR, name)
  const manifestPath = join(pkgDir, 'package.json')
  if (!statSync(pkgDir).isDirectory()) continue
  let manifest
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  } catch {
    // A directory with no readable manifest (an empty leftover) is not a
    // package; it has nothing to promise about a tarball.
    continue
  }
  if (manifest.private === true) continue
  if (manifest.name === undefined) continue
  if (manifest.dsh?.publishCheck === false) continue
  if (typeof manifest.files !== 'string' && !Array.isArray(manifest.files)) continue

  const dest = mkdtempSync(join(tmpdir(), `aishell-pack-${name}-`))
  let failed = 0
  try {
    const { entries, manifest: packed } = packAndRead(pkgDir, dest)

    // 1. The pack must carry a real version, not a workspace placeholder.
    if (typeof packed.version !== 'string' || packed.version.length === 0) {
      failures.push(`${manifest.name}: packed manifest carries no version`)
      failed++
    }

    // 2. No internal dependency may still read `workspace:` — pnpm rewrites
    //    those at pack time, so a leftover means the rewrite did not happen and
    //    the tarball would be uninstallable outside the workspace.
    for (const [dep, range] of Object.entries(packed.dependencies ?? {})) {
      if (typeof range === 'string' && range.startsWith('workspace:')) {
        failures.push(
          `${manifest.name}: dependency ${dep} kept "${range}" in the tarball — ` +
            `this tarball cannot be installed; publish with pnpm, not npm`,
        )
        failed++
      }
    }

    // 3. No separate "are the internal versions consistent" check: it cannot
    //    fire. Every internal edge is `workspace:*`, and pnpm rewrites that to
    //    the dependency's *current* version at pack time, so a stale range is
    //    not a state this workspace can be in. Verified by bumping one package
    //    alone and watching this check stay silent — the rewrite followed.

    // 3. Every promised path must be in the tarball. `files` may be a bare
    //    string, which is one path, not a list of characters.
    const declaredFiles = typeof manifest.files === 'string' ? [manifest.files] : manifest.files
    for (const { path, source } of promisedPaths(manifest, declaredFiles)) {
      if (!shipped(entries, path)) {
        failures.push(`${manifest.name}: ${source} promises "${path}", which is not in the tarball`)
        failed++
      }
    }

    // 4. A package claiming to be a DSH bundle must ship its patch; one that
    //    ships a patch without claiming it would install but never activate.
    const declaresBundle = manifest.dsh?.bundle !== undefined
    const shipsPatch = entries.includes('cordis.patch.yml')
    if (shipsPatch && !declaresBundle) {
      failures.push(
        `${manifest.name}: ships cordis.patch.yml but declares no dsh.bundle — ` +
          `DSH would install it as a plain dependency and never activate it`,
      )
      failed++
    }

    checked.push(`${manifest.name} (${entries.length} entries, v${packed.version})`)
  } catch (error) {
    failures.push(`${manifest.name}: packing failed — ${error.message}`)
    failed++
  } finally {
    rmSync(dest, { recursive: true, force: true })
  }
  // A package either passed in full or is reported as failed — never both, so
  // the OK lines and the summary count cannot disagree with the FAIL lines.
  if (failed > 0) {
    failedNames.add(manifest.name)
    checked.pop()
  }
}

for (const line of checked) console.log(`[check-packages] OK   ${line}`)
for (const line of failures) console.error(`[check-packages] FAIL ${line}`)

if (failures.length > 0) {
  console.error(
    `[check-packages] ${failures.length} problem(s) in ${failedNames.size} of ` +
      `${checked.length + failedNames.size} package(s)`,
  )
  process.exit(1)
}
console.log(`[check-packages] ${checked.length} package(s) verified`)
