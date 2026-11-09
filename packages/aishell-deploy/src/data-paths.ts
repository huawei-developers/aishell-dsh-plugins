/**
 * Where the shipped data files live at runtime.
 *
 * ## Why this is one module
 *
 * Two files ship beside the code and are read at call time: the read-only
 * registry (the table that decides whether an arbitrary URL is a query) and the
 * terraform examples archive.
 *
 * This package is bundled by tsdown into a single `lib/index.js`, so every
 * `import.meta.url` points at that one file. A path written relative to an
 * individual source module would therefore resolve one level too far up —
 * outside the package. The failure would be a missing-data error at the first
 * `openapi_request` or example export, long after the build looked fine.
 *
 * So both lookups go through here, against one directory: `lib/data/`, where
 * the build puts them (see `build:bundle` in `package.json`).
 *
 * ## Why not resolve from `process.cwd()`
 *
 * Because the cwd is the user's workspace. A deployment directory can contain
 * anything, including a `lib/data/permission-registry.json` that would then
 * decide what this plugin considers read-only — a policy file a model's tool
 * call could influence. The plugin's own install location is the only safe
 * base.
 *
 * ## Per-host state, which is different
 *
 * Shipped data is read-only and lives with the code. State this plugin
 * *writes* — the terraform binary cache and provider plugins — belongs beside
 * the rest of the host's data, so it survives a reinstall and is shared by
 * every profile rather than duplicated per package version.
 *
 * That base directory is defined once, in `credentials-store/paths`: this
 * package already depends on the store, so taking it from there keeps one
 * definition rather than adding a second that can drift.
 *
 * @module @huaweidevtools/aishell-dsh-deploy/data-paths
 */

import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { dshHome } from '@huaweidevtools/aishell-dsh-credentials-store/paths'

/**
 * The directory holding the shipped data files.
 *
 * Resolved from this module's own URL. Because the bundle is flat, this file
 * and `lib/index.js` share a directory once compiled, so the result is
 * `<package>/lib/data` in the installed package; the test run exercises the
 * same resolution through the source tree.
 */
export const DATA_DIR = join(dirname(fileURLToPath(import.meta.url)), 'data')

/**
 * Path of one data file.
 *
 * @param name - file name inside the data directory.
 * @returns its absolute path.
 */
export function dataFile(name: string): string {
  return join(DATA_DIR, name)
}

/**
 * The terraform directory: binary cache and provider plugins.
 *
 * Created on demand by the caller that writes into it. Kept as one root rather
 * than a bare `bin`/`plugins` pair so every path under it resolves through
 * `join`, and so a future artifact has an obvious home.
 *
 * @returns `<DSH_HOME>/terraform`; not created here.
 */
export function terraformRoot(): string {
  return join(dshHome(), 'terraform')
}

/** The terraform binary cache: `<DSH_HOME>/terraform/bin`. */
export function terraformBinDir(): string {
  return join(terraformRoot(), 'bin')
}

/** The terraform provider-plugin cache: `<DSH_HOME>/terraform/plugins`. */
export function terraformPluginDir(): string {
  return join(terraformRoot(), 'plugins')
}

/**
 * Where a user-supplied terraform binary path is recorded.
 *
 * `terraform_install` accepts a `terraform_path` the user picked, and every
 * later call has to find that same binary. Passing it per-call was not an
 * option — the path belongs to the deployment, not to one tool invocation — so
 * it is written here and read by `resolveTerraformEnv`, which makes a
 * subsequent `terraform_plan` use the binary `terraform_install` reported.
 */
export function terraformPathRecord(): string {
  return join(terraformRoot(), 'binary-path')
}