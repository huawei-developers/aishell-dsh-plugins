import { defineConfig } from 'tsdown'

/**
 * Build the credential store library: the index entry, the signer module, the
 * shared account vocabulary, the shared IAM verification, and the credential
 * scope. ESM, Node platform, with type declarations.
 *
 * `accounts`, `verify` and `scope` are separate entries rather than re-exports
 * from the index so a consumer that only needs one does not pull the rest —
 * the signer, the verification fetch path — into its bundle.
 *
 * ## The injected scope
 *
 * `AISHELL_CREDENTIAL_SCOPE` decides which credential namespace this build
 * uses: the keyring service becomes `aishell-dsh-<scope>` and the encrypted
 * file `<scope>.credentials.enc`. Default `plugins`.
 *
 * It is substituted as a literal here rather than read from `process.env` at
 * runtime for a reason: the value selects *where credentials live*, so it must
 * not be changeable on a running install by whoever controls the environment.
 * A staging host and a production host differ by how they were built.
 *
 * `src/scope.ts` guards the read with `typeof` so a source run — the test
 * suite, which resolves `src/` directly and never passes through this file —
 * falls back to the default instead of throwing a `ReferenceError`.
 */
const scope = (process.env.AISHELL_CREDENTIAL_SCOPE ?? '').trim() || 'plugins'

export default defineConfig({
  entry: ['src/index.ts', 'src/signer.ts', 'src/accounts.ts', 'src/verify.ts', 'src/scope.ts', 'src/paths.ts'],
  outDir: 'lib',
  format: ['esm'],
  platform: 'node',
  target: 'es2024',
  fixedExtension: false,
  dts: true,
  clean: true,
  define: {
    __AISHELL_CREDENTIAL_SCOPE__: JSON.stringify(scope),
  },
})