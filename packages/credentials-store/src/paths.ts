/**
 * Where per-host state lives. One definition, shared.
 *
 * ## Why one definition
 *
 * `DSH_HOME` is the host's data directory, and two things in this repo derive
 * from it: the encrypted credentials file here, and the terraform cache in
 * `aishell-deploy`. Two resolutions of the same variable can disagree — a
 * trailing-slash difference, a different fallback — and the result is state
 * written to one directory and looked for in another. One definition makes that
 * impossible.
 *
 * It sits in the lower of the two packages because the dependency graph runs
 * that way: `aishell-deploy` already depends on this one, so a definition here
 * is reachable from there, while the reverse would be a cycle.
 *
 * @module @huaweidevtools/aishell-dsh-credentials-store/paths
 */

import { homedir } from 'node:os'
import { join } from 'node:path'

/**
 * The fallback data directory when the host sets no `DSH_HOME`.
 *
 * `~/.aishell` — the same directory the desktop app uses, so a library or
 * headless run lands where a real install keeps its state rather than creating
 * a second home directory.
 */
export const FALLBACK_HOME_NAME = '.aishell'

/**
 * The host's data directory.
 *
 * `DSH_HOME` when the host set it — the desktop app and the CLI both do, so
 * this lands where the rest of that host's data lives — otherwise
 * `~/.aishell`.
 *
 * Read per call, never captured: a host that sets `DSH_HOME` after this module
 * is first imported must still be honoured.
 *
 * @returns the base directory; not created here.
 */
export function dshHome(): string {
  const configured = process.env.DSH_HOME
  if (configured !== undefined && configured.trim() !== '') return configured
  return join(homedir(), FALLBACK_HOME_NAME)
}

/**
 * The directory holding the encrypted credentials file.
 *
 * `<DSH_HOME>/credentials`. Builds are separated by the *file name* (the
 * credential scope — `plugins.credentials.enc` by default), not by a second
 * directory, so two builds sit side by side here without reading each other's
 * secrets.
 *
 * @returns the directory; not created here.
 */
export function credentialsDir(): string {
  return join(dshHome(), 'credentials')
}