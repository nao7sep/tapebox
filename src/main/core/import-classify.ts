import { FlatFilenameSchema, ImportableUrlSchema, type Tape } from '@shared/domain'
import { extname } from 'node:path'
import { portableFilenameIdentity } from '@main/core/filename'
import { checkFormatVersion, FORMAT_VERSIONS } from '@main/io/format-version'
import { message, type Message } from '@shared/i18n/translate'
import { z } from 'zod'

const recordedUtc = z.iso.datetime({ offset: true })
  .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,7})?(?:Z|\+00:00)$/)

/** Validate present fields that enter the catalog; unrelated yt-dlp data is opaque. */
function consumedFieldsValid(sidecar: Record<string, unknown>, fields: Record<string, unknown>): boolean {
  for (const key of ['id', 'extractor', 'title', 'uploader']) {
    if (sidecar[key] != null && typeof sidecar[key] !== 'string') return false
  }
  const duration = sidecar['duration']
  if (duration != null && (typeof duration !== 'number' || !Number.isFinite(duration) || duration < 0)) return false
  if (sidecar['chapters'] != null && !Array.isArray(sidecar['chapters'])) return false
  if (fields['name'] != null && typeof fields['name'] !== 'string') return false
  for (const key of ['addedAtUtc', 'downloadedAtUtc', 'renamedAtUtc']) {
    if (fields[key] != null && !recordedUtc.safeParse(fields[key]).success) return false
  }
  return true
}

// The pure decisions behind `library:import`, lifted out of the IPC handler: the
// sidecar-shape accept/reject classification and the ~25-field Tape construction. The
// handler keeps the filesystem and session work (reading files, the
// already-in-library check, copying into the library); these decide.

export type ImportClassification =
  | { status: 'reject'; reason: Message }
  | { status: 'accept'; sourceUrl: string; mediaFilename: string; thumbnailFilename: string | null }

/**
 * Decide whether a parsed sidecar names a TapeBox bundle that can be imported,
 * pulling out the fields the handler needs. The remaining reject reasons —
 * already in the library, media file missing beside the sidecar — depend on the
 * session and filesystem and stay in the handler.
 */
export function classifyImport(sidecar: unknown): ImportClassification {
  if (!sidecar || typeof sidecar !== 'object' || Array.isArray(sidecar)) {
    return { status: 'reject', reason: message('import.notSidecarRoot') }
  }
  // One in a newer format is reported and left as it is (store-recovery-conventions).
  const version = checkFormatVersion(sidecar as Record<string, unknown>, FORMAT_VERSIONS.sidecar, true)
  if (version.status === 'newer') return { status: 'reject', reason: message('import.sidecarNewer') }
  if (version.status === 'unreadable') return { status: 'reject', reason: message('import.sidecarInvalidJson') }
  const tb = (sidecar as Record<string, unknown>)['tapebox']
  if (!tb || typeof tb !== 'object' || Array.isArray(tb)) {
    return { status: 'reject', reason: message('import.notSidecarNoSection') }
  }
  const fields = tb as Record<string, unknown>
  if (!consumedFieldsValid(sidecar as Record<string, unknown>, fields)) {
    return { status: 'reject', reason: message('import.sidecarInvalidJson') }
  }

  const sourceUrl = ImportableUrlSchema.safeParse(fields['sourceUrl'])
  if (!sourceUrl.success) return { status: 'reject', reason: message('import.sourceUrlInvalid') }

  // The sidecar names its media file — the whole point of importing by sidecar.
  const mediaFilename = FlatFilenameSchema.safeParse(fields['mediaFilename'])
  if (!mediaFilename.success) {
    return {
      status: 'reject',
      reason: message('import.mediaNameInvalid'),
    }
  }

  const thumbnailValue = fields['thumbnailFilename']
  const thumbnailFilename = thumbnailValue == null ? null : FlatFilenameSchema.safeParse(thumbnailValue)
  if (thumbnailFilename !== null && !thumbnailFilename.success) {
    return { status: 'reject', reason: message('import.thumbnailNameInvalid') }
  }

  const media = mediaFilename.data
  const mediaExtension = extname(media)
  if (!mediaExtension) return { status: 'reject', reason: message('import.mediaNoExtension') }
  const sidecarName = `${media.slice(0, -mediaExtension.length)}.json`
  const thumbnail = thumbnailFilename === null ? null : thumbnailFilename.data
  const bundleNames = [media, sidecarName, ...(thumbnail ? [thumbnail] : [])]
  if (new Set(bundleNames.map(portableFilenameIdentity)).size !== bundleNames.length) {
    return { status: 'reject', reason: message('import.bundleNamesClash') }
  }
  return { status: 'accept', sourceUrl: sourceUrl.data, mediaFilename: media, thumbnailFilename: thumbnail }
}

/**
 * Build the library Tape from an imported sidecar after checking consumed fields.
 * Identity, naming, ordering, and the
 * resolved thumbnail are passed in (they depend on nanoid / the order window /
 * filesystem). A time the sidecar does not record stays empty; the import does not
 * probe or download, so it has no such time of its own. The one required time,
 * when the tape was added, falls back to when it was downloaded and only then to
 * `nowUtc`, the import itself (content-lifecycle conventions).
 */
export function tapeFromSidecar(
  sidecar: Record<string, unknown>,
  params: {
    id: string
    sourceUrl: string
    mediaFilename: string
    sidecarFilename: string
    thumbnailFilename: string | null
    order: number
    nowUtc: string
  },
): Tape {
  const tb = (sidecar['tapebox'] as Record<string, unknown> | undefined) ?? {}
  if (!consumedFieldsValid(sidecar, tb)) throw new Error('The sidecar has invalid catalog fields')
  const recordedTime = (key: string): string | null => typeof tb[key] === 'string' ? new Date(tb[key]).toISOString() : null
  const downloadedAtUtc = recordedTime('downloadedAtUtc')
  return {
    id: params.id,
    sourceUrl: params.sourceUrl,
    state: 'downloaded',
    addedAtUtc: recordedTime('addedAtUtc') ?? downloadedAtUtc ?? params.nowUtc,
    sourceId: typeof sidecar['id'] === 'string' ? sidecar['id'] : null,
    extractor: typeof sidecar['extractor'] === 'string' ? sidecar['extractor'] : null,
    title: typeof sidecar['title'] === 'string' ? sidecar['title'] : null,
    uploader: typeof sidecar['uploader'] === 'string' ? sidecar['uploader'] : null,
    durationSeconds: typeof sidecar['duration'] === 'number' ? sidecar['duration'] : null,
    chapterCount: Array.isArray(sidecar['chapters']) ? (sidecar['chapters'] as unknown[]).length : 0,
    probedAtUtc: null,
    filename: params.mediaFilename,
    sidecarFilename: params.sidecarFilename,
    thumbnailFilename: params.thumbnailFilename,
    downloadStartedAtUtc: null,
    downloadedAtUtc,
    name: typeof tb['name'] === 'string' ? tb['name'] : null,
    renamedAtUtc: recordedTime('renamedAtUtc'),
    archivedAtUtc: null,
    boxId: null,
    order: params.order,
    pausedAtUtc: null,
    failedAtUtc: null,
    failureCode: null,
    lastError: null,
  }
}
