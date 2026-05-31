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
 *   playlist   -> probe found a playlist/channel, not a single video; a resting
 *                 dead-end the user resolves via the scanner (Copy URL / Open scanner)
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
  'playlist',
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
  filename: z.string().nullable(),                          // basename only, no path
  sidecarFilename: z.string().nullable(),                   // basename only, no path
  downloadStartedAtUtc: z.string().nullable().default(null), // when state → 'downloading'
  downloadedAtUtc: z.string().nullable(),

  // Filled by rename.
  slug: z.string().nullable(),
  renamedAtUtc: z.string().nullable(),

  // Archive marker (orthogonal to state).
  archivedAtUtc: z.string().nullable(),

  // Archive organization (only meaningful while archived): which box the tape is
  // filed in (null = Ungrouped) and its manual position within that box. Defaulted
  // so sessions written before boxes existed load unchanged.
  groupId: z.string().nullable().default(null),
  archiveOrder: z.number().int().default(0),

  // State-transition markers.
  pausedAtUtc: z.string().nullable().default(null),          // when state → 'paused'
  failedAtUtc: z.string().nullable().default(null),          // when state → 'failed'
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
/**
 * Technical media facts parsed from the actual file (via ffmpeg) at download
 * time — reliable regardless of how rich the source site's yt-dlp extractor is.
 * The UI prefers these over yt-dlp's own (often-missing) fields.
 */
export const SidecarMediaSchema = z.object({
  width: z.number().nullable(),
  height: z.number().nullable(),
  fps: z.number().nullable(),
  vcodec: z.string().nullable(),
  acodec: z.string().nullable(),
  durationSeconds: z.number().nullable(),
  bitrateKbps: z.number().nullable(),
})
export type SidecarMedia = z.infer<typeof SidecarMediaSchema>

export const SidecarTapeboxSchema = z.object({
  sourceUrl: z.string().url(),
  originalTitle: z.string().nullable(),
  slug: z.string().nullable(),
  addedAtUtc: z.string(),
  downloadedAtUtc: z.string().nullable(),
  renamedAtUtc: z.string().nullable(),
  // Null when probing failed or for sidecars written before this existed.
  media: SidecarMediaSchema.nullable().default(null),
})
export type SidecarTapebox = z.infer<typeof SidecarTapeboxSchema>

/**
 * A box: a named, ordered collection of archived tapes. Membership is single — a
 * tape belongs to one box (via Item.groupId) or to Ungrouped. `order` is the
 * box's position in the box list.
 */
export const ArchiveGroupSchema = z.object({
  id: z.string(),
  name: z.string(),
  order: z.number().int(),
})
export type ArchiveGroup = z.infer<typeof ArchiveGroupSchema>

/**
 * Session file shape — persisted in ~/.tapebox/session.json.
 * Live progress data (percent, speed, ETA) is intentionally absent;
 * it's rebuilt by the queue at runtime.
 */
export const SessionSchema = z.object({
  items: z.array(ItemSchema),
  groups: z.array(ArchiveGroupSchema).default([]),
})
export type Session = z.infer<typeof SessionSchema>
