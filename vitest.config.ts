import { defineConfig } from 'vitest/config'
import { resolve } from 'node:path'

// Tests live under tests/, mirroring the src/ layout, so src/ stays pure shipped
// code and the production typecheck (tsc over src/**) never sees test files. The
// alias map mirrors electron.vite.config.ts / tsconfig.json so tests import
// modules by the same @-aliases the app uses.
const alias = {
  '@shared': resolve('src/shared'),
  '@main': resolve('src/main'),
  '@renderer': resolve('src/renderer'),
}

export default defineConfig({
  resolve: { alias },
  test: {
    // Node by default for the pure main/shared logic; the renderer's DOM helpers
    // opt into jsdom per file via a `// @vitest-environment jsdom` pragma.
    environment: 'node',
    include: ['tests/**/*.test.{ts,tsx}'],
    // Keep filesystem and jsdom tests responsive on resource-constrained hosts.
    maxWorkers: 1,
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
        '**/*.d.ts',
      ],
    },
  },
})
