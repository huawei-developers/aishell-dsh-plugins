import { defineConfig } from 'tsdown'

/**
 * Build the aishell-deploy host plugin: ESM, Node platform, with type
 * declarations.
 *
 * The two runtime data files are copied by the `build:bundle` script rather
 * than by tsdown, whose 0.10 release has no `copy` option. See that script and
 * `src/data-paths.ts` — they must agree on `lib/data/`.
 */
export default defineConfig({
  entry: ['src/index.ts'],
  outDir: 'lib',
  format: ['esm'],
  platform: 'node',
  target: 'es2024',
  fixedExtension: false,
  dts: true,
  clean: true,
})
