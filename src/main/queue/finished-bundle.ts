import { stat } from 'node:fs/promises'
import { join } from 'node:path'
import type { Tape } from '@shared/domain'
import { classifyImport, tapeFromSidecar } from '@main/core/import-classify'
import { readSidecarFile } from '@main/core/sidecar'
import type { TapeMove } from '@main/core/tape-state'

/**
 * A download can finish on disk without its catalog commit landing: a crash, a
 * forced exit or Quit anyway after a failed save leaves the tape stored as
 * queued (store/session.ts) beside its finished files. A new attempt clears the
 * tape's whole stem before downloading (services/ytdlp.ts), which would delete
 * what may be the only copy once the source is gone. So a job first looks for
 * the finished bundle and adopts it.
 *
 * The sidecar is written last, after the media and poster, so a sidecar under
 * the tape's own stem marks a finished download. One that names no media on disk
 * leaves nothing to protect, and the attempt starts over; one that cannot be
 * read or does not name this tape's own files is kept as it is, and the job
 * fails rather than clear it.
 */
export type FinishedBundle =
  | { status: 'none' }
  | { status: 'found'; move: TapeMove }
  | { status: 'unusable'; reason: string }

export async function findFinishedBundle(libraryDir: string, tape: Tape, nowUtc: string): Promise<FinishedBundle> {
  const stem = tape.id
  const sidecarFilename = `${stem}.json`
  let sidecar: Record<string, unknown>
  try {
    sidecar = await readSidecarFile(join(libraryDir, sidecarFilename))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { status: 'none' }
    return { status: 'unusable', reason: 'the sidecar could not be read' }
  }

  const bundle = classifyImport(sidecar)
  if (bundle.status === 'reject') return { status: 'unusable', reason: bundle.reason.key }
  if (!bundle.mediaFilename.startsWith(`${stem}.`)) return { status: 'unusable', reason: 'the sidecar names another stem' }
  if (!(await isFile(join(libraryDir, bundle.mediaFilename)))) return { status: 'none' }
  const thumbnailFilename = bundle.thumbnailFilename !== null && await isFile(join(libraryDir, bundle.thumbnailFilename))
    ? bundle.thumbnailFilename
    : null

  const found = tapeFromSidecar(sidecar, {
    id: tape.id,
    sourceUrl: tape.sourceUrl,
    mediaFilename: bundle.mediaFilename,
    sidecarFilename,
    thumbnailFilename,
    order: tape.order,
    nowUtc,
  })
  if (!found.downloadedAtUtc) return { status: 'unusable', reason: 'the sidecar records no download time' }
  return {
    status: 'found',
    move: {
      state: 'downloaded',
      failureCode: null,
      lastError: null,
      // The tape's own probe answer wins; the sidecar fills what the catalog lost.
      sourceId: tape.sourceId ?? found.sourceId,
      extractor: tape.extractor ?? found.extractor,
      title: tape.title ?? found.title,
      uploader: tape.uploader ?? found.uploader,
      durationSeconds: tape.durationSeconds ?? found.durationSeconds,
      chapterCount: tape.sourceId ? tape.chapterCount : found.chapterCount,
      filename: found.filename,
      sidecarFilename,
      thumbnailFilename,
      downloadStartedAtUtc: null,
      downloadedAtUtc: found.downloadedAtUtc,
    },
  }
}

async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile()
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}
