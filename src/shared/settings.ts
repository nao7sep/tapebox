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
 * Configurable AI prompts. Each default lives here in code, so a key missing
 * from a user's config auto-fills (Zod .default) — prompts added by a future
 * app update simply appear. Editing is opt-in via Settings → AI; a Restore
 * button rewrites a field back to its in-code default. Because .default only
 * fills missing keys, a newer app default never overwrites a value the user has
 * saved — they adopt it explicitly by Restoring, then saving.
 *
 * Template tokens are substituted before the call: {title}, {uploader}.
 */
export const DEFAULT_SLUG_PROMPT = `Suggest a short, descriptive file slug for this media item.
Output ONLY the slug — lowercase ASCII letters, digits, and hyphens.
No quotes, no explanation, no trailing period. Aim for under 60 characters;
prefer descriptive English keywords drawn from the title.

<title>{title}</title>
<uploader>{uploader}</uploader>`

export const PromptsSettingsSchema = z.object({
  slug: z.string().default(DEFAULT_SLUG_PROMPT),
})
export type PromptsSettings = z.infer<typeof PromptsSettingsSchema>

/**
 * One policy shape for every class of network work. Fields that don't apply to
 * a given group take their inert form rather than being omitted:
 *   - timeoutMs:   per-attempt deadline — a request deadline, or an idle/stall
 *                  watchdog for streaming transfers. null = no app-imposed
 *                  timeout (rely on the underlying client and manual cancel).
 *   - retries:     retry attempts after the first failure (total = retries + 1).
 *                  0 = never retried, which makes intervals and jitterRatio inert.
 *   - intervals:   wait-before-retry schedule in ms. If retries > intervals.length,
 *                  the last interval is reused. Empty = retry immediately.
 *   - jitterRatio: each interval is randomized by ±ratio to avoid thundering herd.
 */
export const NetworkPolicySchema = z.object({
  timeoutMs: z.number().int().min(1000).nullable(),
  retries: z.number().int().min(0).max(20),
  intervals: z.array(z.number().int().min(0)).max(20),
  jitterRatio: z.number().min(0).max(1),
})
export type NetworkPolicy = z.infer<typeof NetworkPolicySchema>

/**
 * Network work, grouped by who it talks to (which decides what's safe):
 *   - ytdlpProbe: single-video probe + playlist/channel scan against the media
 *     site. Keeps an idle watchdog; defaults to no retry — re-hitting a site
 *     risks an IP block, so opting into retries is the user's deliberate call.
 *   - ytdlpDownload: the media download. Defaults to NO timeout: yt-dlp goes
 *     silent during the post-download ffmpeg merge of a large file, so an idle
 *     watchdog would kill a healthy job mid-merge. yt-dlp owns its own socket
 *     timeouts, and a wedged job is cancellable. No retry, same block reasoning.
 *   - versionCheck: GitHub releases + evermeet.cx ffmpeg info — small GETs, safe
 *     to retry.
 *   - binaryDownload: yt-dlp/ffmpeg/Deno binary downloads from GitHub — safe to
 *     retry (no block risk; a large transfer benefits from auto-resume).
 *   - ai: the AI provider — transient 429/5xx, retried with backoff.
 */
export const NetworkSettingsSchema = z.object({
  ytdlpProbe:     NetworkPolicySchema.default({ timeoutMs: 30_000,  retries: 0, intervals: [],                          jitterRatio: 0   }),
  ytdlpDownload:  NetworkPolicySchema.default({ timeoutMs: null,    retries: 0, intervals: [],                          jitterRatio: 0   }),
  versionCheck:   NetworkPolicySchema.default({ timeoutMs: 30_000,  retries: 3, intervals: [1_000, 3_000, 8_000],       jitterRatio: 0.2 }),
  binaryDownload: NetworkPolicySchema.default({ timeoutMs: 60_000,  retries: 3, intervals: [3_000, 15_000, 60_000],     jitterRatio: 0.2 }),
  ai:             NetworkPolicySchema.default({ timeoutMs: 120_000, retries: 3, intervals: [3_000, 10_000, 30_000],     jitterRatio: 0.2 }),
})
export type NetworkSettings = z.infer<typeof NetworkSettingsSchema>

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
  schemaVersion: z.literal(1),

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

  // Persisted widths (px) of the resizable side panes — the library list on the
  // left and the chapters list on the right. Clamped to a sane range; defaulted
  // so older configs still load.
  leftPaneWidth: z.number().int().min(200).max(720).default(320),
  chaptersPaneWidth: z.number().int().min(200).max(720).default(288),
  // Height (px) of the boxes list above the tape list in the archive organizer.
  archiveBoxesHeight: z.number().int().min(120).max(800).default(240),

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

  retainLogCount: z.number().int().min(0),

  network: NetworkSettingsSchema,

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
    schemaVersion: 1,
    libraryDir,
    autoStartDownloads: true,
    maxConcurrentDownloads: 2,
    autoplay: true,
    playSound: true,
    trashOnRemove: true,
    confirmRemove: true,
    leftPaneWidth: 320,
    chaptersPaneWidth: 288,
    archiveBoxesHeight: 240,
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
    network: {
      ytdlpProbe:     { timeoutMs: 30_000,  retries: 0, intervals: [],                      jitterRatio: 0   },
      ytdlpDownload:  { timeoutMs: null,    retries: 0, intervals: [],                      jitterRatio: 0   },
      versionCheck:   { timeoutMs: 30_000,  retries: 3, intervals: [1_000, 3_000, 8_000],   jitterRatio: 0.2 },
      binaryDownload: { timeoutMs: 60_000,  retries: 3, intervals: [3_000, 15_000, 60_000], jitterRatio: 0.2 },
      ai:             { timeoutMs: 120_000, retries: 3, intervals: [3_000, 10_000, 30_000], jitterRatio: 0.2 },
    },
    ytdlpArgs: '',
    siteProfiles: [],
    externalPlayer: '',
  }
}
