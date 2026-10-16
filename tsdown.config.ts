import { defineConfig } from 'tsdown'

export default defineConfig({
  entry: ['src/main.ts'],
  format: 'esm',
  platform: 'node',
  target: 'node24',
  outDir: 'dist',
  fixedExtension: false,
  clean: true,
  dts: false,
  sourcemap: true,
})
