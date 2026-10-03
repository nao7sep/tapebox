import { readFileSync } from 'node:fs'

import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { resolve } from 'node:path'

/**
 * Electron-vite config for an ESM main process.
 *   - main: ESM output (lib.formats=['es']) so we can require nothing and
 *     consume ESM-only deps (nanoid) directly.
 *   - preload: CommonJS output. Preload runs in a sandboxed context where ESM
 *     loading is not supported in Electron 42; CJS is the standard there.
 *   - renderer: standard Vite browser ESM + Tailwind v4 via its native Vite
 *     plugin (replaces the v3 PostCSS-based pipeline).
 */
// Single source of truth for the app version: package.json, injected as
// __APP_VERSION__. Electron's own getVersion() answers about the running binary,
// so an unpackaged run reported Electron's version as the app's.
const { version } = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'))

export default defineConfig({
  main: {
    define: { __APP_VERSION__: JSON.stringify(version) },
    plugins: [externalizeDepsPlugin()],
    resolve: {
      alias: {
        '@shared': resolve('src/shared'),
        '@main': resolve('src/main'),
      },
    },
    build: {
      rollupOptions: {
        // The records reader runs on its own thread (io/records-read.ts), from
        // its own entry beside index.js.
        input: {
          index: resolve('src/main/index.ts'),
          'records-worker': resolve('src/main/io/records-worker.ts'),
        },
        output: { format: 'es', entryFileNames: '[name].js' },
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
    plugins: [react(), tailwindcss()],
    server: {
      host: '127.0.0.1',
      port: 27143,
      strictPort: true,
    },
    resolve: {
      alias: {
        '@shared': resolve('src/shared'),
        '@renderer': resolve('src/renderer'),
      },
    },
    root: 'src/renderer',
    build: {
      minify: true,
      // Loaded from disk, not over a network: the default 500 kB warning measures
      // transfer cost. 2000 keeps a runaway bundle loud.
      chunkSizeWarningLimit: 2000,
      rollupOptions: {
        input: {
          index: resolve('src/renderer/index.html'),
          records: resolve('src/renderer/records.html'),
        },
      },
    },
  },
})
