import { z } from 'zod'

/**
 * Item lifecycle:
 *   queued     -> just inserted, only URL known
 *   probing    -> running yt-dlp --dump-json --skip-download
 *   ready      -> metadata captured, awaiting download slot
 *   downloading
 *   downloaded -> media + sidecar present in library/
 *   failed
 *   paused
 *
 * 'archivedAtUtc' is orthogonal to state — any state can be archived.
 */
export const itemStates = [
  'queued',
  'probing',
  'ready',
  'downloading',
  'downloaded',
  'failed',
  'paused',
] as const

export type ItemState = (typeof itemStates)[number]

export const ItemSchema = z.object({
  // Required at insertion.
  id: z.string(),                  // internal nanoid; stable for the Item's lifetime
  sourceUrl: z.string().url(),
  state: z.enum(itemStates),
  addedAtUtc: z.string(),

  // Filled by probe.
  sourceId: z.string().nullable(),       // yt-dlp's id; used as on-disk filename stem
  title: z.string().nullable(),
  originalTitle: z.string().nullable(),
  uploader: z.string().nullable(),
  durationSeconds: z.number().nullable(),
  chapterCount: z.number().int().nullable(),
  thumbnailUrl: z.string().nullable(),
  probedAtUtc: z.string().nullable(),

  // Filled by download.
  filename: z.string().nullable(),         // basename only, no path
  sidecarFilename: z.string().nullable(),  // basename only, no path
  downloadedAtUtc: z.string().nullable(),

  // Filled by rename.
  slug: z.string().nullable(),
  renamedAtUtc: z.string().nullable(),

  // Archive (inbox-zero).
  archivedAtUtc: z.string().nullable(),

  // Live error tracking.
  lastError: z.string().nullable(),
})
export type Item = z.infer<typeof ItemSchema>

/**
 * Sidecar JSON layout:
 *   { ...ytDlpInfoJson, tapebox: SidecarTapebox }
 *
 * Path-containing yt-dlp fields (filename, _filename, filepath, etc.) are
 * stripped before write — sidecars must be portable when files move.
 *
 * We do NOT validate the yt-dlp portion; it's a large, evolving surface.
 * We only validate the 'tapebox' namespace below.
 */
export const SidecarTapeboxSchema = z.object({
  schemaVersion: z.literal(1),
  sourceUrl: z.string().url(),
  originalTitle: z.string().nullable(),
  slug: z.string().nullable(),
  addedAtUtc: z.string(),
  downloadedAtUtc: z.string().nullable(),
  renamedAtUtc: z.string().nullable(),
})
export type SidecarTapebox = z.infer<typeof SidecarTapeboxSchema>

/**
 * Session file shape — persisted in ~/.tapebox/session.json.
 * Live progress data (percent, speed, ETA) is intentionally absent;
 * it's rebuilt by the queue at runtime.
 */
export const SessionSchema = z.object({
  schemaVersion: z.literal(1),
  items: z.array(ItemSchema),
})
export type Session = z.infer<typeof SessionSchema>
