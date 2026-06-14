import { z } from 'zod'
import { stripUrlCredentials } from './url'

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

Write the slug in real English words. If the title is in another language, translate its MEANING into English — do not romanize or transliterate it. For example, a Japanese title becomes its English meaning (e.g. "morning-routine"), never its rōmaji (e.g. "asa-no-shuukan"). Proper names — people, places, brands, song or series titles — may stay as written when they have no common English form.

Output ONLY the slug — lowercase ASCII letters, digits, and hyphens, with words separated by single hyphens. No quotes, no explanation, no trailing period. Aim for 3–6 words and under 60 characters.

Base the slug on the title. Use the uploader and description only as supporting context to clarify or disambiguate the subject. Descriptions often carry promotional text, links, hashtags, timestamps, and credits — ignore all of that, and never copy URLs, @handles, hashtags, or sponsor names into the slug.

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

  // Last playback volume (0..1), remembered across tapes and restarts so a new
  // tape opens at the level the user last set rather than resetting to full. Set
  // live from the player's own volume control, not the Settings dialog. Defaulted
  // so configs written before this field existed still load cleanly.
  volume: z.number().min(0).max(1).default(1),

  // Hold an OS wake lock while a tape is playing, so the screen doesn't dim and
  // the machine doesn't sleep mid-watch; released the moment playback stops.
  // Defaulted so configs written before this field existed still load cleanly.
  keepAwakeWhilePlaying: z.boolean().default(true),

  // Removing a tape moves its files to the OS Trash (recoverable) when on, or
  // deletes them permanently when off. confirmRemove gates a confirmation
  // dialog before any removal. Both default on (and are defaulted so older
  // configs still load).
  trashOnRemove: z.boolean().default(true),
  confirmRemove: z.boolean().default(true),

  // Check GitHub/upstream for newer yt-dlp/ffmpeg releases once at startup.
  autoCheckBinaryUpdates: z.boolean(),

  ai: AiSettingsSchema,

  // Configurable AI prompts; defaulted so older configs (and newly-added
  // prompts) auto-fill from code. See PromptsSettingsSchema.
  prompts: PromptsSettingsSchema.default({ slug: DEFAULT_SLUG_PROMPT }),

  binaries: z.object({
    'yt-dlp': BinaryEntrySchema,
    ffmpeg: BinaryEntrySchema,
  }),

  // Extra yt-dlp CLI args. ytdlpArgs applies to every call (probe, download,
  // scan); a matching siteProfile's args are appended on top. The app's own
  // flags win on conflict (they're placed last). Defaulted for older configs.
  ytdlpArgs: z.string().default(''),
  siteProfiles: z.array(SiteProfileSchema).default([]),

  // External player for "Open in player": empty = OS default; otherwise an app
  // name or path (macOS opens it via `open -a`).
  externalPlayer: z.string().default(''),

  // Default destination folder for Export. Empty = unset; the export modal then
  // requires the user to choose a folder before it can run. A set value pre-fills
  // the modal, and the user can still pick a different one for that export.
  defaultExportDir: z.string().default(''),

  // Whether Export removes the tape from the library after copying it out (so it
  // becomes a "move out"). Shown in the export modal as the default, overridable
  // per export. On by default — exporting is usually how a finished tape leaves.
  deleteAfterExport: z.boolean().default(true),
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
    keepAwakeWhilePlaying: true,
    volume: 1,
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
    },
    ytdlpArgs: '',
    siteProfiles: [],
    externalPlayer: '',
    defaultExportDir: '',
    deleteAfterExport: true,
  }
}

/**
 * A summary of the effective settings for the startup record the logging
 * conventions mandate ("the key effective configuration, secrets redacted").
 *
 * The hazard guarded against is a secret living inside a string *value*, which
 * the name-based log redactor cannot catch (it matches denied field names, never
 * string contents). Three kinds of field are therefore handled with care:
 *
 *   - The AI endpoint is logged with URL userinfo stripped (stripUrlCredentials),
 *     because a credential can ride in the `user:password@` of an otherwise
 *     reasonable baseUrl (an auth proxy / gateway), separate from the API key
 *     held in its own file.
 *   - Free-text whose body could carry a credential — `ytdlpArgs` and a site
 *     profile's `args`, where a token can ride inside a header, cookie, or URL —
 *     is reduced to presence/count and never emitted as its value.
 *   - `prompts.slug` is unbounded user text, so it collapses to whether it still
 *     equals the in-code default.
 *
 * Everything else is bounded, non-secret config (paths, the model, the toggles)
 * logged verbatim because it is exactly what a later debugging session needs.
 *
 * Returns a plain object (no logging-layer import) so the domain stays unaware of
 * who consumes it; the caller hands it to the logger as a field.
 */
export function summarizeSettings(s: Settings): Record<string, unknown> {
  return {
    libraryDir: s.libraryDir,
    autoStartDownloads: s.autoStartDownloads,
    maxConcurrentDownloads: s.maxConcurrentDownloads,
    autoplay: s.autoplay,
    playSound: s.playSound,
    keepAwakeWhilePlaying: s.keepAwakeWhilePlaying,
    volume: s.volume,
    trashOnRemove: s.trashOnRemove,
    confirmRemove: s.confirmRemove,
    autoCheckBinaryUpdates: s.autoCheckBinaryUpdates,
    aiBaseUrl: stripUrlCredentials(s.ai.baseUrl),
    aiModel: s.ai.model,
    externalPlayer: s.externalPlayer,
    defaultExportDir: s.defaultExportDir,
    deleteAfterExport: s.deleteAfterExport,
    promptsCustomized: s.prompts.slug !== DEFAULT_SLUG_PROMPT,
    ytdlpArgsSet: s.ytdlpArgs.trim().length > 0,
    siteProfileCount: s.siteProfiles.length,
  }
}
