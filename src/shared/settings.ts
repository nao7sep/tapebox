import { z } from 'zod'

export const BinaryEntrySchema = z.object({
  installedVersion: z.string().nullable(),
  latestKnownVersion: z.string().nullable(),
  lastCheckedAtUtc: z.string().nullable(),
})
export type BinaryEntry = z.infer<typeof BinaryEntrySchema>

/**
 * Single OpenAI-compatible provider configuration. The API key is NOT stored
 * here — it's encrypted with Electron's safeStorage and persisted alongside in
 * a separate file under a fixed slot. Config is safe to read/share without
 * leaking credentials.
 */
export const AiSettingsSchema = z.object({
  baseUrl: z.string().url(),
  model: z.string().min(1),
})
export type AiSettings = z.infer<typeof AiSettingsSchema>

/**
 * Retry/timeout policy for one class of network work.
 *   - timeoutMs:   per-attempt deadline (a request timeout, or an idle/stall
 *                  watchdog for streaming transfers).
 *   - retries:     number of retry attempts after the first failure.
 *                  Total attempts = retries + 1.
 *   - intervals:   wait-before-retry schedule in ms. If retries > intervals.length,
 *                  the last interval is reused for further retries.
 *   - jitterRatio: each interval is randomized by ±ratio to avoid thundering herd.
 */
export const RetryPolicySchema = z.object({
  timeoutMs: z.number().int().min(1000),
  retries: z.number().int().min(0).max(20),
  intervals: z.array(z.number().int().min(0)).max(20),
  jitterRatio: z.number().min(0).max(1),
})
export type RetryPolicy = z.infer<typeof RetryPolicySchema>

/**
 * Network work split into the groups that share a retry/timeout shape:
 *   - lookups:  small request→response — yt-dlp probe/detect/enumerate,
 *               GitHub releases, evermeet.cx ffmpeg info.
 *   - download: large transfers — binary downloads, yt-dlp media download.
 *   - ai:       slug generation via the AI provider.
 */
export const NetworkSettingsSchema = z.object({
  lookups: RetryPolicySchema,
  download: RetryPolicySchema,
  ai: RetryPolicySchema,
})
export type NetworkSettings = z.infer<typeof NetworkSettingsSchema>
export type NetworkGroup = keyof NetworkSettings

export const SettingsSchema = z.object({
  schemaVersion: z.literal(1),

  libraryDir: z.string(),
  autoStartDownloads: z.boolean(),
  maxConcurrentDownloads: z.number().int().min(1).max(8),

  // Check GitHub/upstream for newer yt-dlp/ffmpeg/deno releases once at startup.
  autoCheckBinaryUpdates: z.boolean(),

  ai: AiSettingsSchema,

  binaries: z.object({
    'yt-dlp': BinaryEntrySchema,
    ffmpeg: BinaryEntrySchema,
    deno: BinaryEntrySchema,
  }),

  retainLogCount: z.number().int().min(0),

  network: NetworkSettingsSchema,
})
export type Settings = z.infer<typeof SettingsSchema>

/**
 * Default settings used when config.json is missing on first launch.
 * The libraryDir is parameterized because path resolution lives in main/.
 */
export function defaultSettings(libraryDir: string): Settings {
  return {
    schemaVersion: 1,
    libraryDir,
    autoStartDownloads: true,
    maxConcurrentDownloads: 2,
    autoCheckBinaryUpdates: true,
    ai: {
      baseUrl: 'https://api.openai.com/v1',
      model: 'gpt-5.4-mini',
    },
    binaries: {
      'yt-dlp': { installedVersion: null, latestKnownVersion: null, lastCheckedAtUtc: null },
      ffmpeg:   { installedVersion: null, latestKnownVersion: null, lastCheckedAtUtc: null },
      deno:     { installedVersion: null, latestKnownVersion: null, lastCheckedAtUtc: null },
    },
    retainLogCount: 50,
    network: {
      lookups:  { timeoutMs: 30_000,  retries: 3, intervals: [1_000, 3_000, 8_000],   jitterRatio: 0.2 },
      download: { timeoutMs: 60_000,  retries: 3, intervals: [3_000, 15_000, 60_000], jitterRatio: 0.2 },
      ai:       { timeoutMs: 120_000, retries: 3, intervals: [3_000, 10_000, 30_000], jitterRatio: 0.2 },
    },
  }
}
