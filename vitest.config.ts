import { configDefaults, defineConfig } from 'vitest/config'
import { resolve } from 'node:path'
import { availableParallelism } from 'node:os'
import { aliasMap } from './aliases.config'

import { readFileSync } from 'node:fs';

// __APP_VERSION__ is injected from package.json by electron.vite.config.ts for the
// build; mirrored here so the tests run against the same value.
const { version } = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'));

// Tests live under tests/, mirroring the src/ layout, so src/ stays pure shipped
// code and the production typecheck (tsc over src/**) never sees test files.
// Tests import modules by every alias the app uses.
const alias = aliasMap()

export default defineConfig({
  define: { __APP_VERSION__: JSON.stringify(version) },
  resolve: { alias },
  test: {
    // Node by default for the pure main/shared logic; the renderer's DOM helpers
    // opt into jsdom per file via a `// @vitest-environment jsdom` pragma.
    environment: 'node',
    // Integration files start application workers and owned subprocesses as well
    // as the runner. Reserve CPU for those peers so startup/cancellation tests
    // measure their lifecycle rather than a saturated runner's scheduling delay.
    maxWorkers: Math.max(1, Math.floor(availableParallelism() / 2)),
    // Electron's npm entry downloads its ~100 MB binary the first time anything
    // imports it while the binary is missing, as after a fresh npm ci with install
    // scripts blocked. Unit tests need only the module's path string, never the
    // binary; the live lane, which runs real Electron, does not inherit this.
    env: { ELECTRON_OVERRIDE_DIST_PATH: resolve('tests/no-electron-binary') },
    include: ['tests/**/*.test.{ts,tsx}'],
    // The rendered-key gate watches every test that mounts the interface.
    setupFiles: ['tests/setup/rendered-keys.ts'],
    // Main reads the renderer's colour tokens from globals.css as text (`?raw`);
    // Vitest blanks unprocessed stylesheets unless they are included here.
    css: { include: [/globals\.css/] },
    // tests/live runs the real yt-dlp, ffmpeg, and OpenAI; only
    // vitest.live.config.ts, run by npm run test:full, includes it.
    exclude: [...configDefaults.exclude, 'tests/live/**'],
    coverage: {
      // V8's native coverage; `include` spans all source so the report flags
      // logic no test reaches, not just a score for what is reached.
      provider: 'v8',
      reporter: ['text', 'html', 'lcov'],
      include: ['src/**/*.{ts,tsx}'],
      // Excluded as framework wiring with no decision to cover:
      exclude: [
        'src/main/index.ts', // Electron main entry / bootstrap
        'src/preload/**', // contextBridge wiring
        'src/renderer/main.tsx', // React DOM mount
        'src/renderer/records.tsx', // the Records window's React DOM mount
        '**/*.d.ts',
      ],
    },
  },
})
