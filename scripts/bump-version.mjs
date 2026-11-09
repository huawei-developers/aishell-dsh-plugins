#!/usr/bin/env node
/**
 * Bump the version of every publishable package, then rebuild and verify.
 *
 * ## Why this is a script and not three commands in a README
 *
 * A version bump here has three steps, and two of them are easy to get wrong in
 * ways that fail silently.
 *
 *  1. The bump. `pnpm -r version` also rewrites the root manifest, which is
 *     `private: true` and pinned at `0.0.0` — it is a workspace shell, not a
 *     published package, so a bump that reaches it is wrong. Excluding it needs
 *     a `--filter '!<root name>'` that is not obvious from the command's help.
 *
 *  2. The rebuild. `lib/` is what actually ships and it is gitignored, so a
 *     bump without a rebuild would publish the previous build under the new
 *     version number — with nothing failing.
 *
 *  3. The check. `scripts/check-packages.mjs` packs each package and asserts
 *     the tarball matches its manifest. Cheap, and it runs automatically at
 *     publish — but running it here means a packaging problem surfaces at the
 *     bump rather than after the tree has moved on.
 *
 * Doing all three in one place is the point: the failure modes are silent, so
 * the ordering has to be mechanical.
 *
 * ## Usage
 *
 *   node scripts/bump-version.mjs 0.0.1-beta.2
 *   node scripts/bump-version.mjs prerelease --preid beta
 *   node scripts/bump-version.mjs patch
 *
 * Flags:
 *   --preid <id>     prerelease identifier, passed through to pnpm
 *   --no-build       skip the rebuild (the baked version will be stale)
 *   --no-check       skip the packaging check
 *   --allow-dirty    bump with uncommitted changes (passes pnpm --no-git-checks)
 *
 * The version argument is anything `pnpm version` accepts: an explicit version,
 * or `major` / `minor` / `patch` / `premajor` / `preminor` / `prepatch` /
 * `prerelease`.
 */
import { execFileSync } from 'node:child_process'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'

const REPO_ROOT = resolve(import.meta.dirname, '..')
const PACKAGES_DIR = join(REPO_ROOT, 'packages')

/** Read a manifest, or `undefined` when the path is not one. */
function readManifest(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return undefined
  }
}

/** Every package that is published, with where it lives. */
function publishablePackages() {
  const found = []
  for (const name of readdirSync(PACKAGES_DIR).sort()) {
    const dir = join(PACKAGES_DIR, name)
    if (!statSync(dir).isDirectory()) continue
    const manifest = readManifest(join(dir, 'package.json'))
    if (manifest?.private === true || typeof manifest?.name !== 'string') continue
    found.push({ dir, name: manifest.name, version: manifest.version })
  }
  return found
}

// ── Arguments ───────────────────────────────────────────────────────────────

const argv = process.argv.slice(2)
const flags = new Set(argv.filter(arg => arg.startsWith('--')))
const positional = argv.filter(arg => !arg.startsWith('--'))

const preidIndex = argv.indexOf('--preid')
const preid = preidIndex === -1 ? undefined : argv[preidIndex + 1]
if (preidIndex !== -1 && preid === undefined) {
  console.error('[bump] --preid needs a value')
  process.exit(1)
}

const spec = positional[0]
if (spec === undefined) {
  console.error(
    '[bump] usage: node scripts/bump-version.mjs <version|major|minor|patch|prerelease> [--preid <id>]\n' +
      '                                        [--no-build] [--no-check] [--allow-dirty]',
  )
  process.exit(1)
}
if (positional.length > 1) {
  console.error(`[bump] unexpected extra argument(s): ${positional.slice(1).join(' ')}`)
  process.exit(1)
}

const rootManifest = readManifest(join(REPO_ROOT, 'package.json'))
if (typeof rootManifest?.name !== 'string') {
  console.error('[bump] could not read the root package name')
  process.exit(1)
}

const packages = publishablePackages()
if (packages.length === 0) {
  console.error('[bump] no publishable packages found under packages/')
  process.exit(1)
}

// ── 0. Refuse a dirty tree, before anything is written ──────────────────────
//
// pnpm refuses this itself, but only once it is already running, and its
// message does not say that the bump is the thing that would have been
// committed alongside unrelated work.

if (!flags.has('--allow-dirty')) {
  const status = execFileSync('git', ['status', '--porcelain'], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
  }).trim()
  if (status !== '') {
    const lines = status.split('\n')
    console.error(
      `[bump] the working tree has ${lines.length} uncommitted change(s):\n` +
        lines.slice(0, 5).map(line => `  ${line}`).join('\n') +
        (lines.length > 5 ? `\n  … and ${lines.length - 5} more` : '') +
        '\n\n  Commit them first, so the version bump is its own commit:\n' +
        '    git add -A && git commit\n\n' +
        '  Or pass --allow-dirty to bump anyway (pnpm --no-git-checks).',
    )
    process.exit(1)
  }
}

const before = packages.map(pkg => `${pkg.name}@${pkg.version}`)
console.log(`[bump] ${packages.length} publishable package(s), currently at:`)
for (const line of before) console.log(`         ${line}`)

// ── 1. Bump, excluding the root ─────────────────────────────────────────────

const versionArgs = [
  '--filter', `!${rootManifest.name}`,
  '-r', 'version', spec,
  ...(preid === undefined ? [] : ['--preid', preid]),
  ...(flags.has('--allow-dirty') ? ['--no-git-checks'] : []),
]
console.log(`\n[bump] pnpm ${versionArgs.join(' ')}`)
try {
  execFileSync('pnpm', versionArgs, { cwd: REPO_ROOT, stdio: 'inherit' })
} catch {
  console.error('[bump] the version bump failed; nothing else was run')
  process.exit(1)
}

// ── 2. Verify what moved ────────────────────────────────────────────────────
//
// The root must not have moved: it is private and its version is meaningless,
// but `pnpm -r version` would have rewritten it without the filter.

const after = publishablePackages()
const versions = new Set(after.map(pkg => pkg.version))
if (versions.size !== 1) {
  console.error(
    `[bump] the packages did not all land on one version: ${[...versions].join(', ')}\n` +
      '  Internal dependencies are pinned at pack time to each dependency\'s own\n' +
      '  version, so a split here would publish a set that cannot resolve.',
  )
  process.exit(1)
}
const nextVersion = after[0].version

const rootNow = readManifest(join(REPO_ROOT, 'package.json'))
if (rootNow?.version !== rootManifest.version) {
  console.error(
    `[bump] the root version moved (${rootManifest.version} -> ${rootNow?.version}).\n` +
      `  It must stay pinned: it is private and never published. Restore it and re-run.`,
  )
  process.exit(1)
}

console.log(`\n[bump] all ${after.length} package(s) now at ${nextVersion}`)

// ── 3. Rebuild ──────────────────────────────────────────────────────────────
//
// The manifests carry the new version; `lib/` is what actually ships, and it is
// gitignored, so a stale build would publish code that predates the bump. This
// is the only step that makes the two agree.

if (flags.has('--no-build')) {
  console.log('[bump] --no-build: skipping the rebuild; lib/ still holds the previous build')
} else {
  console.log('\n[bump] rebuilding')
  try {
    execFileSync('pnpm', ['run', 'build'], { cwd: REPO_ROOT, stdio: 'inherit' })
  } catch {
    console.error(
      '\n[bump] the rebuild failed. The manifests are bumped but lib/ is stale —\n' +
        '  fix the build before publishing.',
    )
    process.exit(1)
  }
}

// ── 4. Verify the packages still pack correctly ─────────────────────────────

if (flags.has('--no-check')) {
  console.log('[bump] --no-check: skipping the packaging check')
} else {
  console.log('\n[bump] checking the packages')
  try {
    execFileSync('node', [join(REPO_ROOT, 'scripts', 'check-packages.mjs')], {
      cwd: REPO_ROOT,
      stdio: 'inherit',
    })
  } catch {
    console.error('[bump] the packaging check failed; see above')
    process.exit(1)
  }
}

console.log(
  `\n[bump] done — ${after.length} package(s) at ${nextVersion}` +
    (flags.has('--no-build') ? ' (bundles not rebuilt)' : '') +
    '\n\nNext:\n' +
    `  git add -A && git commit -m "chore: bump version to ${nextVersion}"\n` +
    '  pnpm run publish',
)
