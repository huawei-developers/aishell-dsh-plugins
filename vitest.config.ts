import { defineConfig } from 'vitest/config'
import { fileURLToPath } from 'node:url'

const resolve = (p: string): string => fileURLToPath(new URL(p, import.meta.url))

export default defineConfig({
  resolve: {
    alias: {
      // The root package does not depend on the credential store, but the test
      // setup must reach it to seal the keyring. Source, not `lib/`, so the
      // seal does not require a build first. Every subpath needs its own entry:
      // a plain string alias matches the prefix and would swallow them into the
      // index module — which resolves (the index exists) and then fails at
      // runtime with an undefined export, the least useful form of this mistake.
      '@huaweidevtools/aishell-dsh-credentials-store/signer': resolve('./packages/credentials-store/src/signer.ts'),
      '@huaweidevtools/aishell-dsh-credentials-store/accounts': resolve('./packages/credentials-store/src/accounts.ts'),
      '@huaweidevtools/aishell-dsh-credentials-store/verify': resolve('./packages/credentials-store/src/verify.ts'),
      '@huaweidevtools/aishell-dsh-credentials-store/paths': resolve('./packages/credentials-store/src/paths.ts'),
      '@huaweidevtools/aishell-dsh-credentials-store/scope': resolve('./packages/credentials-store/src/scope.ts'),
      '@huaweidevtools/aishell-dsh-credentials-store': resolve('./packages/credentials-store/src/index.ts'),
    },
  },
  test: {
    include: ['packages/**/tests/*.spec.ts'],
    // Every test process starts here: the OS keyring is sealed and the
    // home-derived credential paths are redirected into a temp directory, so a
    // test cannot write the developer's real credentials. See vitest.setup.ts.
    setupFiles: ['./vitest.setup.ts'],
    coverage: {
      provider: 'v8',
      include: ['packages/**/src/**/*.ts'],
    },
  },
})
