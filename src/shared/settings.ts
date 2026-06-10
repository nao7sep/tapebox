import { z } from 'zod'

export const BinaryEntrySchema = z.object({
  installedVersion: z.string().nullable(),
  latestKnownVersion: z.string().nullable(),
  lastCheckedAtUtc: z.string().nullable(),
})
export type BinaryEntry = z.infer<typeof BinaryEntrySchema>

/**
 * Single OpenAI-compatible provider configuration. The API key is stored
 * separately in lightly obfuscated local JSON under a fixed slot.
 */
export const AiSettingsSchema = z.object({
  baseUrl: z.string().url(),
  model: z.string().min(1),
})
export type AiSettings = z.infer<typeof AiSettingsSchema>

/**
 * Configurable AI prompts. Each default lives here in code, so a key missing
 * from a user's config auto-fills (Zod .default) — prompts added by a future
 * app update simply appear. Editing is opt-in via Settings → AI; a Restore
 * button rewrites a field back to its in-code default. Because .default only
 * fills missing keys, a newer app default never overwrites a value the user has
 * saved — they adopt it explicitly by Restoring, then saving.
 *
 * Template tokens are substituted before the call: {title}, {uploader},
 * {description}. A token the user omits is simply not sent; a token left in
 * substitutes to empty when that field is unavailable.
 */
export const DEFAULT_SLUG_PROMPT = `Suggest a short, descriptive file slug for this media item.
Output ONLY the slug — lowercase ASCII letters, digits, and hyphens.
No quotes, no explanation, no trailing period. Aim for under 60 characters;
prefer descriptive English keywords that capture the core subject.

Base the slug on the title. Use the uploader and description only as supporting
context to clarify or disambiguate the subject. Descriptions often carry
promotional text, links, hashtags, timestamps, and credits — ignore all of
that, and never copy URLs, @handles, hashtags, or sponsor names into the slug.

<title>
{title}
</title>

<uploader>
{uploader}
</uploader>

<description>
{description}
</description>`

export const PromptsSettingsSchema = z.object({
  slug: z.string().default(DEFAULT_SLUG_PROMPT),
})
export type PromptsSettings = z.infer<typeof PromptsSettingsSchema>

/**
 * A per-site yt-dlp override. When a URL matches urlPattern (substring match, or
 * a regex when isRegex is on — for host variants like ja.example.com), the args
 * (a raw CLI line) are appended to that yt-dlp call. comment is a user note.
 */
export const SiteProfileSchema = z.object({
  id: z.string(),
  name: z.string(),
  urlPattern: z.string(),
  isRegex: z.boolean(),
  args: z.string(),
  comment: z.string(),
})
export type SiteProfile = z.infer<typeof SiteProfileSchema>

export const SettingsSchema = z.object({
  libraryDir: z.string(),
  autoStartDownloads: z.boolean(),
  maxConcurrentDownloads: z.number().int().min(1).max(8),

  // Start playback automatically when a downloaded tape is opened in the player.
  // Defaulted so configs written before this field existed still load cleanly.
  autoplay: z.boolean().default(true),

  // Play video audio. When off, every video is muted and can't be unmuted.
  playSound: z.boolean().default(true),

  // Removing a tape moves its files to the OS Trash (recoverable) when on, or
  // deletes them permanently when off. confirmRemove gates a confirmation
  // dialog before any removal. Both default on (and are defaulted so older
  // configs still load).
  trashOnRemove: z.boolean().default(true),
  confirmRemove: z.boolean().default(true),

  // Check GitHub/upstream for newer yt-dlp/ffmpeg/deno releases once at startup.
  autoCheckBinaryUpdates: z.boolean(),

  ai: AiSettingsSchema,

  // Configurable AI prompts; defaulted so older configs (and newly-added
  // prompts) auto-fill from code. See PromptsSettingsSchema.
  prompts: PromptsSettingsSchema.default({ slug: DEFAULT_SLUG_PROMPT }),

  binaries: z.object({
    'yt-dlp': BinaryEntrySchema,
    ffmpeg: BinaryEntrySchema,
    deno: BinaryEntrySchema,
  }),

  // Keep only this many per-launch log files. Defaulted so configs written while
  // the setting was absent, or before it existed, still load cleanly.
  retainLogCount: z.number().int().min(0).default(50),

  // Extra yt-dlp CLI args. ytdlpArgs applies to every call (probe, download,
  // scan); a matching siteProfile's args are appended on top. The app's own
  // flags win on conflict (they're placed last). Defaulted for older configs.
  ytdlpArgs: z.string().default(''),
  siteProfiles: z.array(SiteProfileSchema).default([]),

  // External player for "Open in player": empty = OS default; otherwise an app
  // name or path (macOS opens it via `open -a`).
  externalPlayer: z.string().default(''),
})
export type Settings = z.infer<typeof SettingsSchema>

/**
 * Default settings used when config.json is missing on first launch.
 * The libraryDir is parameterized because path resolution lives in main/.
 */
export function defaultSettings(libraryDir: string): Settings {
  return {
    libraryDir,
    autoStartDownloads: true,
    maxConcurrentDownloads: 2,
    autoplay: true,
    playSound: true,
    trashOnRemove: true,
    confirmRemove: true,
    autoCheckBinaryUpdates: true,
    ai: {
      baseUrl: 'https://api.openai.com/v1',
      model: 'gpt-5.4-mini',
    },
    prompts: {
      slug: DEFAULT_SLUG_PROMPT,
    },
    binaries: {
      'yt-dlp': { installedVersion: null, latestKnownVersion: null, lastCheckedAtUtc: null },
      ffmpeg:   { installedVersion: null, latestKnownVersion: null, lastCheckedAtUtc: null },
      deno:     { installedVersion: null, latestKnownVersion: null, lastCheckedAtUtc: null },
    },
    retainLogCount: 50,
    ytdlpArgs: '',
    siteProfiles: [],
    externalPlayer: '',
  }
}
