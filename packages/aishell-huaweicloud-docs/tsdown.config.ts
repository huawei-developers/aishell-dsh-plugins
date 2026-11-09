import { defineConfig } from 'tsdown'

/** Build the Huawei Cloud docs pointer plugin: ESM, Node platform, with type declarations. */
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
