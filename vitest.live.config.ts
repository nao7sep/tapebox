import { configDefaults, defineConfig } from 'vitest/config'

import base from './vitest.config'

// The live lane: the real managed yt-dlp, ffmpeg, and deno, and the real OpenAI
// API, run only by npm run test:full. Files run one at a time because they
// share the tool cache, spend money, and wait on the network.
export default defineConfig({
  define: base.define,
  resolve: base.resolve,
  test: {
    environment: 'node',
    css: base.test?.css,
    include: ['tests/live/**/*.test.ts'],
    exclude: configDefaults.exclude,
    fileParallelism: false,
    // No deadlines here either: a wait that never ends is a hang to diagnose.
    testTimeout: 0,
    hookTimeout: 0,
  },
})
