/**
 * Test-time machine-state seal.
 *
 * ## Why this exists
 *
 * Twice now, a test suite in this repo has written into the developer's real
 * machine state and destroyed their live credentials. Both times it was silent
 * — the suite went green, and the damage only surfaced hours later as an
 * unrelated-looking failure (`403 AK not in whitelist` from the gateway).
 *
 * The mechanism was always the same shape: a module loaded through
 * `createRequire`, which `vi.mock` cannot intercept. The mocked name is
 * silently ignored, the real module loads, and fixtures land in production
 * storage. Documenting the trap was not enough — the failure gave no signal.
 *
 * So this module removes the possibility rather than warning about it. Every
 * test process starts here, and here the OS keyring is sealed and the
 * home-derived credential paths are redirected into a temp directory. The seal
 * is then verified **functionally**, so one that quietly stopped working fails
 * the run instead of restoring false confidence.
 *
 * ## Giving a test its own keyring
 *
 * Install a stub through the package's own seam — the one that works:
 *
 * ```ts
 * import { __setKeyringModule } from '@huaweidevtools/aishell-dsh-credentials-store'
 *
 * class MockEntry {
 *   constructor(private readonly service: string, private readonly account: string) {}
 *   setPassword(v: string) { /* ... *\/ }
 *   getPassword() { return null }
 *   deletePassword() {}
 * }
 *
 * __setKeyringModule({ Entry: MockEntry })
 * ```
 *
 * ## Opting out
 *
 * A test that is genuinely *about* real storage sets
 * `AISHELL_TEST_ALLOW_REAL_MACHINE_STATE=1` before the run:
 *
 * ```sh
 * AISHELL_TEST_ALLOW_REAL_MACHINE_STATE=1 npx vitest run
 * ```
 *
 * Prefer a stub; reach for this only when real storage is the subject.
 *
 * @module vitest.setup
 */

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  KeyringBackend,
  __setKeyringModule,
  createCredentialsStore,
} from '@huaweidevtools/aishell-dsh-credentials-store'

/** Set this to let a run touch the real machine. Anything else keeps the seal. */
export const ALLOW_ENV = 'AISHELL_TEST_ALLOW_REAL_MACHINE_STATE'

/** Whether this run opted out of the seal. */
export const realStateAllowed = (): boolean => process.env[ALLOW_ENV] === '1'

/** Message every sealed keyring access throws. */
function sealedMessage(service: string, account: string): string {
  return [
    `Refusing to touch the real OS keyring from a test (service="${service}", account="${account}").`,
    '',
    'Give the test its own keyring instead:',
    "  import { __setKeyringModule } from '@huaweidevtools/aishell-dsh-credentials-store'",
    '  __setKeyringModule({ Entry: MockEntry })',
    '',
    'If the test is genuinely about real storage, opt out for that run:',
    `  ${ALLOW_ENV}=1 npx vitest run`,
    '',
    'vi.mock cannot replace this seam.',
  ].join('\n')
}

if (realStateAllowed()) {
  console.warn(
    `[vitest.setup] ${ALLOW_ENV}=1 — tests may touch REAL machine state `
    + '(OS keyring, credentials directory).',
  )
} else {
  // 1. Seal the OS keyring. Constructing an Entry throws, so KeyringBackend's
  //    own construction probe fails and the factory falls through to the file
  //    backend — which step 2 points at a temp directory.
  __setKeyringModule({
    Entry: class {
      constructor(service: string, account: string) {
        throw new Error(sealedMessage(service, account))
      }
    },
  })

  // 2. Redirect home-derived paths. FingerprintBackend resolves its file as
  //    `$DSH_HOME/credentials`, or `~/.<service>/credentials` otherwise; both
  //    would land in the developer's real data.
  const sandbox = mkdtempSync(join(tmpdir(), 'aishell-test-home-'))
  process.env.DSH_HOME = sandbox
  process.env.HOME = sandbox

  // 3. Verify the seal functionally. With the keyring sealed, the factory
  //    cannot produce a KeyringBackend — its construction probe throws. If one
  //    comes back, the seal is not in force and tests could reach real storage.
  const probe = createCredentialsStore()
  if (probe instanceof KeyringBackend) {
    throw new Error(
      '[vitest.setup] keyring seal is NOT in force: createCredentialsStore() returned a live '
      + 'KeyringBackend, which means tests could write the real OS keyring. '
      + 'Refusing to run.',
    )
  }

  // 4. And verify the file backend is sandboxed, so the fallback cannot reach
  //    the real credentials directory either.
  if (!sandbox.startsWith(tmpdir())) {
    throw new Error(`[vitest.setup] sandbox directory "${sandbox}" is not under ${tmpdir()}.`)
  }
}
