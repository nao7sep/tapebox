import { z } from 'zod'

/**
 * An OpenAI-compatible provider profile. The API key is NOT stored here —
 * it's encrypted with Electron's safeStorage and persisted alongside in a
 * separate file, keyed by profile id. Config is safe to read/share without
 * leaking credentials.
 */
/**
 * 'kind' is forward-looking: 'openai-compatible' covers OpenAI, OpenRouter,
 * Groq, Together, etc. When native Anthropic or Gemini providers are added
 * later, the enum grows and ai-client dispatches on kind.
 */
export const AiProfileSchema = z.object({
  id: z.string(),
  name: z.string(),
  baseUrl: z.string().url(),
  model: z.string(),
  kind: z.enum(['openai-compatible']).default('openai-compatible'),
})
export type AiProfile = z.infer<typeof AiProfileSchema>

export const BinaryEntrySchema = z.object({
  installedVersion: z.string().nullable(),
  lastCheckedAtUtc: z.string().nullable(),
})
export type BinaryEntry = z.infer<typeof BinaryEntrySchema>

/**
 * Retry/timeout policy for one class of network work.
 *   - timeoutMs: per-attempt deadline (a request timeout, or an idle/stall
 *     watchdog for streaming transfers).
 *   - intervals: wait-before-retry schedule in ms. Its LENGTH is the retry
 *     count, so [] means no retries and attempts = intervals.length + 1.
 *   - jitterRatio: each interval is randomized by ±ratio to avoid thundering herd.
 */
export const RetryPolicySchema = z.object({
  timeoutMs: z.number().int().min(1000),
  intervals: z.array(z.number().int().min(0)).max(10),
  jitterRatio: z.number().min(0).max(1),
})
export type RetryPolicy = z.infer<typeof RetryPolicySchema>

/**
 * Network work split into the few groups that share a retry/timeout shape:
 *   - metadata: quick request→response (yt-dlp probe/detect, version lookups)
 *   - download: large transfers (binary downloads, yt-dlp media download)
 *   - ai:       slug generation via the AI provider
 */
export const NetworkSettingsSchema = z.object({
  metadata: RetryPolicySchema,
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

  aiProfiles: z.array(AiProfileSchema),
  activeAiProfileId: z.string().nullable(),

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
    aiProfiles: [],
    activeAiProfileId: null,
    binaries: {
      'yt-dlp': { installedVersion: null, lastCheckedAtUtc: null },
      ffmpeg:   { installedVersion: null, lastCheckedAtUtc: null },
      deno:     { installedVersion: null, lastCheckedAtUtc: null },
    },
    retainLogCount: 50,
    network: {
      metadata: { timeoutMs: 30_000, intervals: [1_000, 3_000, 8_000], jitterRatio: 0.2 },
      download: { timeoutMs: 60_000, intervals: [2_000, 10_000], jitterRatio: 0.2 },
      ai:       { timeoutMs: 60_000, intervals: [1_000, 4_000, 10_000], jitterRatio: 0.25 },
    },
  }
}

/**
 * Default AI profiles offered when the user opens Settings for the first time.
 * Models chosen for cheap, fast slug generation (May 2026 lineup); user can edit.
 */
export function defaultAiProfileSuggestions(): AiProfile[] {
  return [
    {
      id: 'openai',
      name: 'OpenAI',
      baseUrl: 'https://api.openai.com/v1',
      model: 'gpt-5.4-mini',
      kind: 'openai-compatible',
    },
    {
      id: 'openrouter',
      name: 'OpenRouter',
      baseUrl: 'https://openrouter.ai/api/v1',
      model: 'google/gemini-2.5-flash-lite',
      kind: 'openai-compatible',
    },
  ]
}
