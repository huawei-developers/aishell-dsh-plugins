/**
 * Publishing a skill bundle into the directory the harness scans.
 *
 * ## Why the target is the filesystem and not a skill provider
 *
 * The harness already scans `<host home>/skills` for `<name>/SKILL.md` and
 * watches it, so a bundle written there appears in the session catalog and the
 * `/` menu without this plugin registering anything with `ctx.skills`.
 * Registering a provider instead would give skills a second home — two sources
 * merged by name, two lifecycles, and an install that survives neither the
 * restart nor the loader's own discovery.
 *
 * The property this rests on: a directory appearing under the skills root reaches
 * `ctx.skills.list()` within one watcher tick, and removing it removes the skill.
 * Verified against the real registry.
 *
 * Everything here therefore treats an install as a file copy that has to be safe
 * to run twice and safe to fail halfway: a bundle is assembled in a staging
 * directory and moved into place with one rename, so the watcher never observes
 * a partial skill.
 *
 * ## What is deliberately not checked
 *
 * A skill's contents are not validated, inspected, or filtered. The catalogue is
 * a list of bundles and the market moves them; whether a bundle's instructions
 * are good, or whether the tools it names exist, is not a question this package
 * answers.
 *
 * @module @huaweidevtools/aishell-dsh-huaweicloud-skills-market/install
 */

import { cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'

/**
 * The marker file an install writes beside `SKILL.md`.
 *
 * Its presence is the only thing that distinguishes a bundle this plugin
 * installed from one the person wrote by hand. Without it, uninstalling would
 * delete authored work and installing would silently overwrite it — both
 * irreversible from the plugin's side.
 */
export const INSTALL_MARKER = '.market-install.json'

/**
 * Staging directory, inside the skills root but never scanned as a skill.
 *
 * It lives under the root rather than beside it because the final move must be a
 * same-filesystem rename: a rename across filesystems is a copy, which is not
 * atomic and would let the watcher see a half-written bundle. Discovery ignores
 * it twice over — the name starts with a dot, and a directory without `SKILL.md`
 * is not a skill. Both were confirmed against the real provider.
 */
const STAGING_DIR = '.market-staging'

/** Where a replaced bundle waits for deletion; ignored for the same reasons. */
const TRASH_DIR = '.market-staging-trash'

/** What the marker records about one install. */
export interface InstallRecord {
  /** Kebab-case skill name, as installed. */
  readonly name: string
  /** Path of the bundle inside the upstream repository. */
  readonly path: string
  /** When the install happened, ISO-8601. */
  readonly installedAt: string
}

/** Why a write was refused, in terms the Page words itself. */
export interface InstallRefusal {
  /** Stable reason, matching one of the route's codes. */
  readonly code: 'name-taken' | 'not-installed-here'
}

/** The answer to one publish or removal attempt. */
export type InstallOutcome =
  | { readonly ok: true }
  | { readonly ok: false, readonly refusal: InstallRefusal }

/** The three directories one skills root implies. */
export interface MarketplacePaths {
  /** The directory the harness scans; a bundle lands at `<root>/<name>`. */
  readonly skillsRoot: string
  /** Where a bundle is assembled before its rename. */
  readonly stagingRoot: string
  /** Where a replaced bundle waits for deletion. */
  readonly trashRoot: string
}

/**
 * Derive the three directories from one skills root.
 *
 * @param skillsRoot - the directory the harness scans, such as `<host home>/skills`.
 * @returns the paths this plugin writes.
 */
export function marketplacePaths(skillsRoot: string): MarketplacePaths {
  return {
    skillsRoot,
    stagingRoot: join(skillsRoot, STAGING_DIR),
    trashRoot: join(skillsRoot, TRASH_DIR),
  }
}

/**
 * Whether a directory was published by this plugin.
 *
 * @param directory - a candidate bundle directory.
 * @returns whether it carries the install marker.
 */
export function isMarketInstalled(directory: string): boolean {
  try {
    return statSync(join(directory, INSTALL_MARKER)).isFile()
  } catch {
    return false
  }
}

/**
 * Read a bundle's install record, when it has one.
 *
 * A malformed marker is treated as absent rather than throwing: the file is
 * ours, but a half-written one — a crash mid-install, a hand edit — must not
 * make the catalogue unreadable.
 *
 * @param directory - a bundle directory.
 * @returns the record, or undefined when there is none to read.
 */
export function readInstallRecord(directory: string): InstallRecord | undefined {
  let raw: string
  try {
    raw = readFileSync(join(directory, INSTALL_MARKER), 'utf8')
  } catch {
    return undefined
  }
  try {
    const value: unknown = JSON.parse(raw)
    if (typeof value !== 'object' || value === null) return undefined
    const record = value as Partial<InstallRecord>
    if (typeof record.name !== 'string' || typeof record.path !== 'string') return undefined
    return {
      name: record.name,
      path: record.path,
      installedAt: typeof record.installedAt === 'string' ? record.installedAt : '',
    }
  } catch {
    return undefined
  }
}

/**
 * Names of the bundles this plugin installed under a skills root.
 *
 * A hand-authored skill of the same name is invisible here on purpose: the card
 * must render "not installed" for it, because the only action offered is one
 * that would replace it, and that is refused elsewhere.
 *
 * @param skillsRoot - the directory the harness scans.
 * @returns installed skill names, sorted.
 */
export function listInstalled(skillsRoot: string): string[] {
  let entries
  try {
    entries = readdirSync(skillsRoot, { withFileTypes: true })
  } catch {
    return []
  }
  return entries
    .filter(entry => entry.isDirectory() && isMarketInstalled(join(skillsRoot, entry.name)))
    .map(entry => entry.name)
    .sort()
}

/**
 * Publish a bundle under the skills root by copying a directory out of the
 * working copy.
 *
 * The bundle is assembled inside the skills root's staging directory, then moved
 * into place with one rename. On any failure the staging directory is removed,
 * so a refused install leaves nothing behind and the catalogue is unchanged.
 *
 * @param paths - the three roots from {@link marketplacePaths}; created as needed.
 * @param name - the kebab-case skill name; the bundle lands at `<skillsRoot>/<name>`.
 * @param source - the bundle directory in the working copy.
 * @param record - what the marker records about this install.
 * @returns the outcome.
 * @throws when the filesystem refuses a write the caller should surface as a failure.
 */
export function installBundle(
  paths: MarketplacePaths,
  name: string,
  source: string,
  record: InstallRecord,
): InstallOutcome {
  const target = join(paths.skillsRoot, name)
  if (statSyncOrUndefined(target)?.isDirectory() === true && !isMarketInstalled(target)) {
    return { ok: false, refusal: { code: 'name-taken' } }
  }
  // A unique directory per install, named by the filesystem: two installs can
  // arrive in the same millisecond, and a timestamp would put them in one
  // directory where each copy lands on top of the other.
  mkdirSync(paths.stagingRoot, { recursive: true })
  const staging = mkdtempSync(join(paths.stagingRoot, `${name}-`))
  try {
    cpSync(source, staging, { recursive: true })
    // Replacing the bundle's own marker, if the upstream shipped one: the record
    // has to describe this install, not whatever the bundle carried.
    writeFileSync(join(staging, INSTALL_MARKER), `${JSON.stringify(record)}\n`)
    commit(staging, target, paths.trashRoot)
    return { ok: true }
  } catch (error: unknown) {
    rmSync(staging, { recursive: true, force: true })
    throw error
  }
}

/**
 * Remove a bundle this plugin installed.
 *
 * Refused for a directory it did not write, so a hand-authored skill of the same
 * name survives an uninstall that was not about it. A name that is not present
 * counts as removed — the caller asked for an end state, not an event.
 *
 * @param skillsRoot - the directory the harness scans.
 * @param name - the skill name to remove.
 * @returns the outcome.
 */
export function uninstallBundle(skillsRoot: string, name: string): InstallOutcome {
  const target = join(skillsRoot, name)
  if (statSyncOrUndefined(target)?.isDirectory() !== true) return { ok: true }
  if (!isMarketInstalled(target)) {
    return { ok: false, refusal: { code: 'not-installed-here' } }
  }
  // One rename away from the scanned name, then a delete: between those two the
  // name is absent rather than half-present, which is a state a watcher can
  // observe safely.
  const trash = freeName(skillsRoot, `${TRASH_DIR}-${basename(target)}-`)
  renameSync(target, trash)
  rmSync(trash, { recursive: true, force: true })
  return { ok: true }
}

/**
 * Move a staged bundle into place, replacing a market-installed predecessor.
 *
 * Three renames and no copy: the old bundle leaves the scanned name before the new
 * one takes it, so the watcher observes either the old bundle, the new one, or
 * nothing — never a directory holding both. The empty window is a scheduling
 * artefact, and a catalogue read inside it lists the skill as absent for one
 * tick, which is the same thing the person asked for by updating.
 *
 * A failed rename puts the previous bundle back rather than leaving the name
 * empty: the install failed, so the person should keep what they had.
 *
 * @param staging - the assembled bundle.
 * @param target - the scanned name it must occupy.
 * @param trashRoot - where a replaced bundle waits for deletion.
 */
function commit(staging: string, target: string, trashRoot: string): void {
  let previous: string | undefined
  if (statSyncOrUndefined(target)?.isDirectory() === true) {
    mkdirSync(trashRoot, { recursive: true })
    previous = freeName(trashRoot, `${basename(target)}-`)
    renameSync(target, previous)
  }
  try {
    mkdirSync(dirname(target), { recursive: true })
    renameSync(staging, target)
  } catch (error: unknown) {
    if (previous !== undefined) {
      try {
        renameSync(previous, target)
      } catch {
        // The restore failed too; the trash copy is still on disk and the
        // original error is the one worth reporting.
      }
    }
    throw error
  }
  if (previous !== undefined) rmSync(previous, { recursive: true, force: true })
}

/**
 * A path under `parent` that nothing holds, for a rename to land on.
 *
 * `mkdtempSync` is the filesystem's own unique-name generator, and it reserves
 * the name by creating the directory. A rename *destination* must not already
 * exist — `renameSync` into an existing directory merges into it rather than
 * taking the name — so the reservation is released before the caller renames
 * onto it.
 *
 * @param parent - the directory the name is created in.
 * @param prefix - the stem the name starts with.
 * @returns the free path; not existing when this returns.
 */
function freeName(parent: string, prefix: string): string {
  mkdirSync(parent, { recursive: true })
  const reserved = mkdtempSync(join(parent, prefix))
  rmdirSync(reserved)
  return reserved
}

/**
 * `statSync`, answering undefined for an absent path.
 *
 * @param path - the path to inspect.
 * @returns its stats, or undefined when nothing is there.
 */
function statSyncOrUndefined(path: string): ReturnType<typeof statSync> | undefined {
  try {
    return statSync(path)
  } catch {
    return undefined
  }
}