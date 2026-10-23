import { readFileSync } from 'node:fs'

import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import runtimeEntries from './runtime-entries.json'
import { resolve } from 'node:path'
import { aliasMap } from './aliases.config'

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

const inputs = (entries: Record<string, string>) => Object.fromEntries(Object.entries(entries).map(([name, source]) => [name, resolve(source)]))

export default defineConfig({
  main: {
    define: { __APP_VERSION__: JSON.stringify(version) },
    plugins: [externalizeDepsPlugin()],
    resolve: { alias: aliasMap('@shared', '@main') },
    build: {
      rollupOptions: {
        // Each worker thread runs from its own entry beside index.js, named after
        // its source file, which is the name the code that starts it uses.
        input: inputs(runtimeEntries.main),
        output: { format: 'es', entryFileNames: '[name].js' },
      },
    },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    resolve: { alias: aliasMap('@shared') },
    build: {
      rollupOptions: {
        input: inputs(runtimeEntries.preload),
        output: { format: 'cjs', entryFileNames: '[name].cjs' },
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
    resolve: { alias: aliasMap('@shared', '@renderer') },
    root: 'src/renderer',
    build: {
      minify: true,
      // Loaded from disk, not over a network: the default 500 kB warning measures
      // transfer cost. 2000 keeps a runaway bundle loud.
      chunkSizeWarningLimit: 2000,
      rollupOptions: {
        input: inputs(runtimeEntries.renderer),
      },
    },
  },
})
