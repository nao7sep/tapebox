import type { Tape } from '@shared/domain'

// The pure decisions behind `library:import`, lifted out of the IPC handler: the
// sidecar-shape accept/reject classification and the ~25-field Tape coercion. The
// handler keeps the filesystem and session work (reading files, the
// already-in-library check, copying into the library); these decide.

export type ImportClassification =
  | { status: 'reject'; reason: string }
  | { status: 'accept'; sourceUrl: string; mediaFilename: string; thumbnailFilename: string | null }

/**
 * Decide whether a parsed sidecar names a TapeBox bundle that can be imported,
 * pulling out the fields the handler needs. The remaining reject reasons —
 * already in the library, media file missing beside the sidecar — depend on the
 * session and filesystem and stay in the handler.
 */
export function classifyImport(sidecar: Record<string, unknown>): ImportClassification {
  const tb = sidecar['tapebox'] as Record<string, unknown> | undefined
  if (!tb || typeof tb['sourceUrl'] !== 'string') {
    return { status: 'reject', reason: 'not a TapeBox sidecar (missing tapebox.sourceUrl)' }
  }

  // The sidecar names its media file — the whole point of importing by sidecar.
  const mediaFilename = typeof tb['mediaFilename'] === 'string' ? tb['mediaFilename'] : null
  if (!mediaFilename) {
    return {
      status: 'reject',
      reason: 'sidecar doesn’t name its media file — re-export it from a current build',
    }
  }

  const thumbnailFilename = typeof tb['thumbnailFilename'] === 'string' ? tb['thumbnailFilename'] : null
  return { status: 'accept', sourceUrl: tb['sourceUrl'], mediaFilename, thumbnailFilename }
}

/**
 * Build the library Tape from an imported sidecar, coercing every field with the
 * same type guards the live import uses. Identity, naming, ordering, and the
 * resolved thumbnail are passed in (they depend on nanoid / the order window /
 * filesystem); `nowUtc` is the single timestamp used for every clock-derived
 * default, so all of them agree.
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
  return {
    id: params.id,
    sourceUrl: params.sourceUrl,
    state: 'downloaded',
    addedAtUtc: (typeof tb['addedAtUtc'] === 'string' ? tb['addedAtUtc'] : null) ?? params.nowUtc,
    sourceId: typeof sidecar['id'] === 'string' ? sidecar['id'] : null,
    extractor: typeof sidecar['extractor'] === 'string' ? sidecar['extractor'] : null,
    title: typeof sidecar['title'] === 'string' ? sidecar['title'] : null,
    uploader: typeof sidecar['uploader'] === 'string' ? sidecar['uploader'] : null,
    durationSeconds: typeof sidecar['duration'] === 'number' ? sidecar['duration'] : null,
    chapterCount: Array.isArray(sidecar['chapters']) ? (sidecar['chapters'] as unknown[]).length : 0,
    probedAtUtc: params.nowUtc,
    filename: params.mediaFilename,
    sidecarFilename: params.sidecarFilename,
    thumbnailFilename: params.thumbnailFilename,
    downloadStartedAtUtc: null,
    downloadedAtUtc: typeof tb['downloadedAtUtc'] === 'string' ? tb['downloadedAtUtc'] : params.nowUtc,
    name: typeof tb['name'] === 'string' ? tb['name'] : null,
    renamedAtUtc: typeof tb['renamedAtUtc'] === 'string' ? tb['renamedAtUtc'] : null,
    archivedAtUtc: null,
    boxId: null,
    order: params.order,
    pausedAtUtc: null,
    failedAtUtc: null,
    lastError: null,
  }
}
