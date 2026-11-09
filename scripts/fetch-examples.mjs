#!/usr/bin/env node
/**
 * Fetch the Huawei Cloud Terraform examples and bundle them for shipping.
 *
 * ## What this produces
 *
 * `packages/aishell-deploy/src/data/terraform-examples.zip` — the `examples/`
 * tree of the official `terraform-provider-huaweicloud` repository, which
 * `aishell__terraform_examples_export` unpacks into a directory the model reads.
 *
 * ## Why it is not committed
 *
 * Two reasons, and neither is about disk:
 *
 *   - **It is derived, not authored.** Every byte of it is a copy of a public
 *     repository at a point in time. Committing it means the repository carries
 *     1650 files nobody edits, and a rebuild that rewrites them all.
 *   - **It goes stale silently.** A committed copy looks current forever; a
 *     missing one forces this script, which fetches the provider's examples as
 *     they are today.
 *
 * It *is* shipped in the published package — `build:bundle` copies it into
 * `lib/data/` — so an installed plugin carries the examples and needs no
 * network at run time.
 *
 * ## Why sparse checkout
 *
 * The provider repository is large, and its Go source is irrelevant here. Only
 * `examples/` is wanted, so the clone asks for no blobs and then checks out one
 * directory. That is the difference between a few hundred kilobytes and the
 * whole provider.
 *
 * ## Why two remotes
 *
 * The provider is mirrored on GitCode and hosted on GitHub. GitCode is tried
 * first because GitHub is often unreachable from mainland networks, which is
 * where this product is deployed. The second attempt is not a fallback for
 * convenience — without it, the fetch fails for a reason unrelated to this
 * code.
 *
 * @module scripts/fetch-examples
 */

import { execFileSync } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** Repository root, derived from this file so the script runs from anywhere. */
const ROOT = fileURLToPath(new URL('..', import.meta.url))

/** Where the archive is written. */
const OUTPUT = join(ROOT, 'packages', 'aishell-deploy', 'src', 'data', 'terraform-examples.zip')

/**
 * Remotes to try, in order.
 *
 * Mirrored first: the primary host is frequently unreachable from the networks
 * this product runs on.
 */
const REMOTES = [
  'https://gitcode.com/huaweicloud/terraform-provider-huaweicloud.git',
  'https://github.com/huaweicloud/terraform-provider-huaweicloud.git',
]

/** The directory inside the repository that is wanted, and its name in the zip. */
const EXAMPLES_DIR = 'examples'

/**
 * Clone one remote's `examples/` directory into `dest`.
 *
 * @param remote - repository URL.
 * @param dest - empty directory to clone into.
 * @throws when the clone or the sparse checkout fails.
 */
function cloneExamples(remote, dest) {
  console.log(`Fetching examples from ${remote} ...`)
  // Blobless + sparse: the commit and tree objects only, then one directory.
  // `--depth 1` keeps the history out; nothing here reads it.
  execFileSync('git', ['clone', '--depth', '1', '--filter=blob:none', '--sparse', remote, dest], {
    stdio: 'inherit',
  })
  execFileSync('git', ['sparse-checkout', 'set', EXAMPLES_DIR], { cwd: dest, stdio: 'inherit' })
}

/**
 * Pack the cloned `examples/` tree into `OUTPUT`.
 *
 * `zip` rather than a tar: the extraction path in the plugin already handles
 * zip (the terraform binary download is a zip too), and one archive format for
 * every shipped asset is one code path to keep working.
 *
 * @param cloneDir - the clone's working tree.
 * @throws when the checkout produced no examples.
 */
function packZip(cloneDir) {
  const examples = join(cloneDir, EXAMPLES_DIR)
  if (!existsSync(examples)) {
    throw new Error(`the checkout has no ${EXAMPLES_DIR}/ directory — the remote may have moved`)
  }
  // Run from inside the clone so the archive carries `examples/…` paths with no
  // leading directory of this machine's making. `-r` recurses, `-q` because a
  // 1600-line file list is noise.
  execFileSync('zip', ['-r', '-q', OUTPUT, EXAMPLES_DIR], { cwd: cloneDir, stdio: 'inherit' })
}

/**
 * Run the fetch, trying each remote until one works.
 *
 * A fresh temporary directory per attempt: a failed clone leaves debris, and
 * reusing the directory would make the next attempt fail for a reason that has
 * nothing to do with its remote.
 */
async function main() {
  const failures = []
  for (const remote of REMOTES) {
    const cloneDir = await mkdtemp(join(tmpdir(), 'aishell-examples-'))
    try {
      cloneExamples(remote, cloneDir)
      packZip(cloneDir)
      console.log(`Wrote ${OUTPUT}`)
      return
    } catch (error) {
      failures.push(`${remote}: ${error instanceof Error ? error.message : String(error)}`)
    } finally {
      await rm(cloneDir, { recursive: true, force: true })
    }
  }

  console.error('Every source failed:\n' + failures.map(line => `  - ${line}`).join('\n'))
  process.exitCode = 1
}

await main()