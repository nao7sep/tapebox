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

export const binaryUpdatePolicies = ['always', 'daily', 'weekly', 'prompt', 'manual'] as const
export const BinaryUpdatePolicySchema = z.enum(binaryUpdatePolicies)
export type BinaryUpdatePolicy = z.infer<typeof BinaryUpdatePolicySchema>

export const BinaryEntrySchema = z.object({
  updatePolicy: BinaryUpdatePolicySchema,
  installedVersion: z.string().nullable(),
  lastCheckedAtUtc: z.string().nullable(),
})
export type BinaryEntry = z.infer<typeof BinaryEntrySchema>

export const SettingsSchema = z.object({
  schemaVersion: z.literal(1),

  libraryDir: z.string(),
  autoStartDownloads: z.boolean(),
  maxConcurrentDownloads: z.number().int().min(1).max(8),

  aiProfiles: z.array(AiProfileSchema),
  activeAiProfileId: z.string().nullable(),

  binaries: z.object({
    'yt-dlp': BinaryEntrySchema,
    ffmpeg: BinaryEntrySchema,
    deno: BinaryEntrySchema,
  }),

  retainLogCount: z.number().int().min(0),
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
    aiProfiles: [],
    activeAiProfileId: null,
    binaries: {
      'yt-dlp': { updatePolicy: 'always', installedVersion: null, lastCheckedAtUtc: null },
      ffmpeg:   { updatePolicy: 'manual', installedVersion: null, lastCheckedAtUtc: null },
      deno:     { updatePolicy: 'manual', installedVersion: null, lastCheckedAtUtc: null },
    },
    retainLogCount: 50,
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
