import { defineConfig } from 'tsdown'

/** Build the QR-code tool plugin: ESM, Node platform, with type declarations. */
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