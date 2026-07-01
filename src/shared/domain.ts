import { z } from 'zod'

/**
 * Tape lifecycle:
 *   queued     -> just inserted, only URL known
 *   probing    -> running yt-dlp --dump-json --skip-download
 *   ready      -> metadata captured, awaiting download slot
 *   downloading
 *   downloaded -> media + sidecar present in library/
 *   failed
 *   paused
 *   listing    -> probe found a page that lists videos, not a single video; a
 *                 resting dead-end the user resolves by scanning it (Copy URL / Scan page)
 *
 * 'archivedAtUtc' is orthogonal to state — any state can be archived.
 */
export const tapeStates = [
  'queued',
  'probing',
  'ready',
  'downloading',
  'downloaded',
  'failed',
  'paused',
  'listing',
] as const

export type TapeState = (typeof tapeStates)[number]

export const TapeSchema = z.object({
  // Required at insertion.
  id: z.string(),                  // internal nanoid; stable for the Tape's lifetime
  sourceUrl: z.string().url(),
  state: z.enum(tapeStates),
  addedAtUtc: z.string(),

  // Filled by probe.
  sourceId: z.string().nullable(),       // yt-dlp's id (unique only within an extractor)
  extractor: z.string().nullable(),      // yt-dlp's extractor; with sourceId, the duplicate-detection key
  title: z.string().nullable(),
  uploader: z.string().nullable(),
  durationSeconds: z.number().nullable(),
  chapterCount: z.number().int().nullable(),
  probedAtUtc: z.string().nullable(),

  // Filled by download. On-disk files are named by the tape's id (see core/stem.ts),
  // not by sourceId; the rename later re-stems them all to the chosen name.
  filename: z.string().nullable(),                          // basename only, no path
  sidecarFilename: z.string().nullable(),                   // basename only, no path
  thumbnailFilename: z.string().nullable(),   // local poster (.jpg) basename, no path; null if the source had none
  downloadStartedAtUtc: z.string().nullable(), // when state → 'downloading'
  downloadedAtUtc: z.string().nullable(),

  // Filled by rename: the user-chosen filename stem — a slug the AI suggested, or
  // any filesystem-safe name the user typed. Null until the tape is renamed.
  name: z.string().nullable(),
  renamedAtUtc: z.string().nullable(),

  // Archive marker (orthogonal to state).
  archivedAtUtc: z.string().nullable(),

  // Which box an archived tape is filed in (null = Unboxed, and always null while
  // in the inbox).
  boxId: z.string().nullable(),

  // Manual position within the tape's CURRENT list — the inbox, a box, or Unboxed.
  // Lower = nearer the top; new tapes get an order below everything else so they
  // land on top (see @shared/order).
  order: z.number().int(),

  // State-transition markers.
  pausedAtUtc: z.string().nullable(),          // when state → 'paused'
  failedAtUtc: z.string().nullable(),          // when state → 'failed'
  lastError: z.string().nullable(),
})
export type Tape = z.infer<typeof TapeSchema>

/**
 * Sidecar JSON layout:
 *   { ...ytDlpInfoJson, tapebox: SidecarTapeBox }
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

export const SidecarTapeBoxSchema = z.object({
  sourceUrl: z.string().url(),
  name: z.string().nullable(),
  addedAtUtc: z.string(),
  downloadedAtUtc: z.string().nullable(),
  renamedAtUtc: z.string().nullable(),
  // Null when probing failed.
  media: SidecarMediaSchema.nullable(),
  // The bundle's own file names (basenames, no path), stored so an exported tape
  // can be re-imported from its sidecar ALONE: the sidecar names which sibling file
  // is the video and which is the poster, so import never guesses by stem or
  // mistakes the thumbnail for the media. mediaFilename is the video; thumbnailFilename
  // the local poster (null if the source had none).
  mediaFilename: z.string().nullable(),
  thumbnailFilename: z.string().nullable(),
})
export type SidecarTapeBox = z.infer<typeof SidecarTapeBoxSchema>

/**
 * A box: a named, ordered collection of archived tapes. Membership is single — a
 * tape belongs to one box (via Tape.boxId) or to Unboxed. `order` is the
 * box's position in the box list.
 */
export const BoxSchema = z.object({
  id: z.string(),
  name: z.string(),
  order: z.number().int(),
})
export type Box = z.infer<typeof BoxSchema>

/**
 * Session file shape — persisted in ~/.tapebox/catalog.json.
 * Live progress data (percent, speed, ETA) is intentionally absent;
 * it's rebuilt by the queue at runtime.
 */
export const SessionSchema = z.object({
  tapes: z.array(TapeSchema),
  boxes: z.array(BoxSchema),
})
export type Session = z.infer<typeof SessionSchema>
