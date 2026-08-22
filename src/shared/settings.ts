import { z } from 'zod'
import { stripUrlCredentials } from './url'

// The per-binary managed-dependency facts (installed/latest versions, last-check
// time) are NOT config — they are app-recorded facts and live in their own
// dependencies.json / Dependencies type (see shared/dependencies.ts), per
// persisted-store-separation-conventions. They used to hang off Settings.binaries.

/**
 * Single OpenAI-compatible provider configuration. The API key is stored
 * separately in lightly obfuscated local JSON under a fixed slot.
 */
/**
 * The AI base URL must use https, so the API key is never sent in plaintext —
 * except to a loopback endpoint (a local OpenAI-compatible server like Ollama or
 * LM Studio), where http is normal and the request never leaves the machine. This
 * blocks a plaintext key leak to a remote host without breaking local endpoints.
 */
function isLoopbackOrHttps(raw: string): boolean {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return false
  }
  if (url.protocol === 'https:') return true
  if (url.protocol === 'http:') {
    return ['localhost', '127.0.0.1', '[::1]', '::1'].includes(url.hostname)
  }
  return false
}

export const AiSettingsSchema = z.object({
  baseUrl: z.string().url().refine(isLoopbackOrHttps, {
    message: 'AI base URL must use https (http is allowed only for a localhost endpoint).',
  }),
  model: z.string().min(1),
})
export type AiSettings = z.infer<typeof AiSettingsSchema>

/**
 * Configurable AI prompts. The in-code DEFAULT_SLUG_PROMPT seeds a fresh config
 * (see defaultSettings) and backs the Settings → AI "Reset slug prompt"
 * button, which rewrites a field back to it. The schema is authoritative — `slug`
 * is required, not defaulted; the config writer always emits it.
 *
 * Template tokens are substituted before the call: {title}, {uploader},
 * {description}. A token the user omits is simply not sent; a token left in
 * substitutes to empty when that field is unavailable.
 */
/**
 * The AI endpoint and model a fresh config starts on. Named (not inline in
 * defaultSettings) so the Settings placeholders show the real default instead of a
 * copy that silently goes stale — the same reason DEFAULT_SLUG_PROMPT is named.
 *
 * The model is free text: TapeBox targets any OpenAI-compatible endpoint, so there
 * is no list to pick from and a wrong name is the provider's error at call time,
 * not something this app pre-checks (ai-model-routing-conventions, open branch).
 */
export const DEFAULT_AI_BASE_URL = 'https://api.openai.com/v1'
export const DEFAULT_AI_MODEL = 'gpt-5.6-luna'

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
  slug: z.string(),
})
export type PromptsSettings = z.infer<typeof PromptsSettingsSchema>

/**
 * A per-site yt-dlp override. When a URL matches urlPattern (substring match, or
 * a regex when isRegex is on — for host variants like ja.example.com), the args
 * (a raw CLI line) are appended to that yt-dlp call. comment is a user note.
 */
export const SiteProfileSchema = z.object({
  id: z.string().regex(/^[A-Za-z0-9_-]{8}$/),
  name: z.string(),
  urlPattern: z.string(),
  isRegex: z.boolean(),
  args: z.string(),
  comment: z.string(),
})
export type SiteProfile = z.infer<typeof SiteProfileSchema>

const SettingsObjectSchema = z.object({
  // Folder where the library lives — where tapes are saved and read from. Empty =
  // use the default library folder (~/.tapebox/library); main resolves it via
  // getLibraryDir(). A set value is a custom folder used as-is. Never read this as a
  // path directly in main — always go through getLibraryDir() so an empty value
  // can't become a cwd-relative path. Changing this relocates the existing library:
  // ipc/settings moves every tracked file to the new folder before committing the
  // new value (refused while downloads are running).
  libraryDir: z.string(),
  autoStartDownloads: z.boolean(),
  maxConcurrentDownloads: z.number().int().min(1).max(8),

  // Start playback automatically when a downloaded tape is opened in the player.
  autoplay: z.boolean(),

  // Play video audio. When off, every video is muted and can't be unmuted.
  playSound: z.boolean(),

  // Last playback volume lives in the layout (state) store, not here — it is set
  // live from the player's own volume slider, a moment-to-moment view adjustment
  // rather than an authored setting (persisted-store-separation-conventions). See
  // shared/layout.ts.

  // Hold an OS wake lock while a tape is playing, so the screen doesn't dim and
  // the machine doesn't sleep mid-watch; released the moment playback stops.
  keepAwakeWhilePlaying: z.boolean(),

  // Removing a tape moves its files to the OS Trash (recoverable) when on, or
  // deletes them permanently when off. confirmRemove gates a confirmation
  // dialog before any removal.
  trashOnRemove: z.boolean(),
  confirmRemove: z.boolean(),

  // The one managed-tool toggle (managed-runtime-dependencies-conventions): whether
  // to check GitHub/upstream for newer yt-dlp/ffmpeg/deno once at launch and surface
  // anything needing attention. Nothing auto-downloads or auto-installs; every
  // install and update is user-triggered in the tools modal.
  checkUpdatesAtLaunch: z.boolean(),

  ai: AiSettingsSchema,

  // Configurable AI prompts. See PromptsSettingsSchema.
  prompts: PromptsSettingsSchema,

  // Extra yt-dlp CLI args. ytdlpArgs applies to every call (probe, download,
  // scan); a matching siteProfile's args are appended on top. The app's own
  // flags win on conflict (they're placed last).
  ytdlpArgs: z.string(),
  siteProfiles: z.array(SiteProfileSchema),

  // External player for "Open in player": empty = OS default; otherwise an app
  // name or path (macOS opens it via `open -a`).
  externalPlayer: z.string(),

  // Default destination folder for Export. Empty = unset; the export modal then
  // requires the user to choose a folder before it can run. A set value pre-fills
  // the modal, and the user can still pick a different one for that export.
  defaultExportDir: z.string(),

  // Whether Export removes the tape from the library after copying it out (so it
  // becomes a "move out"). Shown in the export modal as the default, overridable
  // per export. On by default — exporting is usually how a finished tape leaves.
  deleteAfterExport: z.boolean(),

  // UI font family. Empty = use the built-in default stack (globals.css @theme
  // --font-sans); a non-empty value overrides --font-sans at runtime and is handed
  // to CSS verbatim, so the browser resolves the comma-separated stack and falls
  // back on its own (app-chrome-conventions: web fonts are engine-resolved, never
  // parsed here). Family only — there is deliberately no UI font-size knob.
  uiFontFamily: z.string(),
})

export const SettingsPatchSchema = SettingsObjectSchema.partial()

export const SettingsSchema = SettingsObjectSchema.superRefine((settings, ctx) => {
  const ids = new Set<string>()
  for (let i = 0; i < settings.siteProfiles.length; i++) {
    const id = settings.siteProfiles[i]!.id
    if (ids.has(id)) {
      ctx.addIssue({ code: 'custom', path: ['siteProfiles', i, 'id'], message: `duplicate site profile id: ${id}` })
    }
    ids.add(id)
  }
})
export type Settings = z.infer<typeof SettingsSchema>

/**
 * Default settings used when config.json is missing on first launch.
 * libraryDir defaults to '' — an empty value means "use the default library
 * folder", which main/ resolves to paths.library via getLibraryDir(). The actual
 * path lives in main/ (path resolution stays there); the persisted default is just
 * blank, exactly like defaultExportDir.
 */
export function defaultSettings(): Settings {
  return {
    libraryDir: '',
    autoStartDownloads: true,
    maxConcurrentDownloads: 2,
    autoplay: true,
    playSound: true,
    keepAwakeWhilePlaying: true,
    trashOnRemove: true,
    confirmRemove: true,
    checkUpdatesAtLaunch: true,
    ai: {
      baseUrl: DEFAULT_AI_BASE_URL,
      model: DEFAULT_AI_MODEL,
    },
    prompts: {
      slug: DEFAULT_SLUG_PROMPT,
    },
    ytdlpArgs: '',
    siteProfiles: [],
    externalPlayer: '',
    defaultExportDir: '',
    deleteAfterExport: true,
    uiFontFamily: '',
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
    trashOnRemove: s.trashOnRemove,
    confirmRemove: s.confirmRemove,
    checkUpdatesAtLaunch: s.checkUpdatesAtLaunch,
    aiBaseUrl: stripUrlCredentials(s.ai.baseUrl),
    aiModel: s.ai.model,
    externalPlayer: s.externalPlayer,
    defaultExportDir: s.defaultExportDir,
    deleteAfterExport: s.deleteAfterExport,
    promptsCustomized: s.prompts.slug !== DEFAULT_SLUG_PROMPT,
    ytdlpArgsSet: s.ytdlpArgs.trim().length > 0,
    siteProfileCount: s.siteProfiles.length,
    uiFontFamily: s.uiFontFamily,
  }
}
