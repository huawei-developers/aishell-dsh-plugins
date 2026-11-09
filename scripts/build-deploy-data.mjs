#!/usr/bin/env node
/**
 * Copy the shipped data files into the built package, failing loudly if one is
 * missing.
 *
 * ## Why this is not a bare `cp`
 *
 * The archive these copy is fetched, not committed — so a fresh clone has no
 * `src/data/terraform-examples.zip` until someone runs `pnpm run fetch-examples`.
 * A bare `cp -R src/data lib/data` there fails with "no such file or directory",
 * which reads like the directory was misplaced rather than like a step was
 * skipped. This names the step.
 *
 * ## Why the check runs before the copy
 *
 * So the build stops before producing a `lib/` that looks complete and is not.
 * A package missing its data builds clean and fails at the first call to the
 * tool that reads it, which is a much worse place to find out.
 *
 * @module scripts/copy-data
 */

import { copyFileSync, existsSync, mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** Repository root, derived from this file so the script runs from anywhere. */
const ROOT = fileURLToPath(new URL('..', import.meta.url))

/** The package whose data ships with it. */
const PACKAGE = join(ROOT, 'packages', 'aishell-deploy')

/** Source directory, inside the package's source tree. */
const SOURCE = join(PACKAGE, 'src', 'data')

/** Destination, beside the compiled entry point. */
const DEST = join(PACKAGE, 'lib', 'data')

/**
 * Every file that must be present.
 *
 * Listed rather than discovered: a directory scan would happily copy a partial
 * set, and the file that is missing is exactly the one whose absence matters.
 */
const REQUIRED = [
  {
    name: 'permission-registry.json',
    remedy: 'This file is committed — restore it from the repository.',
  },
  {
    name: 'terraform-examples.zip',
    remedy: 'Run `pnpm run fetch-examples` to fetch it.',
  },
]

/** Stop the build with a message naming the missing file and how to get it. */
function fail(missing) {
  console.error(
    'aishell-deploy: cannot build — the package is missing data files:\n'
    + missing.map(entry => `  - ${entry.name}: ${entry.remedy}`).join('\n'),
  )
  process.exit(1)
}

const missing = REQUIRED.filter(entry => !existsSync(join(SOURCE, entry.name)))
if (missing.length > 0) fail(missing)

// Replace rather than merge: a file removed from `src/data` must not survive in
// `lib/data` from an earlier build.
rmSync(DEST, { recursive: true, force: true })
mkdirSync(DEST, { recursive: true })
for (const entry of REQUIRED) {
  copyFileSync(join(SOURCE, entry.name), join(DEST, entry.name))
}
console.log(`aishell-deploy: copied ${REQUIRED.length} data file(s) to lib/data`)