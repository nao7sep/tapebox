import { configDefaults, defineConfig } from 'vitest/config'

import base from './vitest.config'

// The live lane: the real managed yt-dlp, ffmpeg, and deno, and the real OpenAI
// API, run only by npm run check:full. Files run one at a time because they
// share the tool cache, spend money, and wait on the network.
export default defineConfig({
  resolve: base.resolve,
  test: {
    environment: 'node',
    include: ['tests/live/**/*.test.ts'],
    exclude: configDefaults.exclude,
    fileParallelism: false,
    testTimeout: 15 * 60_000,
    hookTimeout: 30 * 60_000,
  },
})
