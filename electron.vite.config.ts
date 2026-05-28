import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'
import { resolve } from 'node:path'

/**
 * Electron-vite config for an ESM main process.
 *   - main: ESM output (lib.formats=['es']) so we can require nothing and
 *     consume ESM-only deps (nanoid, write-file-atomic) directly.
 *   - preload: CommonJS output. Preload runs in a sandboxed context where ESM
 *     loading is not supported in Electron 42; CJS is the standard there.
 *   - renderer: standard Vite browser ESM.
 */
export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    resolve: {
      alias: {
        '@shared': resolve('src/shared'),
        '@main': resolve('src/main'),
      },
    },
    build: {
      rollupOptions: {
        output: { format: 'es' },
      },
    },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    resolve: {
      alias: {
        '@shared': resolve('src/shared'),
      },
    },
    build: {
      rollupOptions: {
        output: { format: 'cjs' },
      },
    },
  },
  renderer: {
    plugins: [react()],
    resolve: {
      alias: {
        '@shared': resolve('src/shared'),
        '@renderer': resolve('src/renderer'),
      },
    },
    root: 'src/renderer',
    build: {
      rollupOptions: {
        input: resolve('src/renderer/index.html'),
      },
    },
  },
})
