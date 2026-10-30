import { readdir, stat } from 'node:fs/promises'
import { extname, join } from 'node:path'
import type { Tape } from '@shared/domain'
import { tapeFromSidecar } from '@main/core/import-classify'
import { readSidecarFile } from '@main/core/sidecar'
import type { TapeMove } from '@main/core/tape-state'
import { SourceIndex, tapeSourceRef } from '@shared/source-identity'

/**
 * A download can finish on disk without its catalog commit landing: a crash, a
 * forced exit or Quit anyway after a failed save leaves the tape stored as
 * queued (store/session.ts) beside its finished files. A new attempt clears the
 * tape's whole stem before downloading (services/ytdlp.ts), which would delete
 * what may be the only copy once the source is gone. So a job first looks in
 * the tape's folder for the finished bundle and adopts it.
 *
 * The sidecar is written last, after the media and poster, so a sidecar under
 * the tape's own stem marks a finished download, and its time is the
 * download's. The media is the one other file under the stem that is neither
 * an image nor a partial download; with none on disk there is nothing to
 * protect, and the attempt starts over. A sidecar that cannot be read, that
 * yt-dlp wrote for another source, or a folder that leaves the media in doubt
 * is kept as it is, and the job fails rather than clear it.
 */
export type FinishedBundle =
  | { status: 'none' }
  | { status: 'found'; move: TapeMove }
  | { status: 'unusable'; reason: string }

// What yt-dlp and the image gate leave under the stem besides the media.
const NOT_MEDIA = new Set(['.json', '.jpg', '.jpeg', '.png', '.webp', '.gif', '.part', '.ytdl'])

export async function findFinishedBundle(dir: string, tape: Tape): Promise<FinishedBundle> {
  const stem = tape.id
  const sidecarFilename = `${stem}.json`
  let sidecar: Record<string, unknown>
  let downloadedAtUtc: string
  try {
    sidecar = await readSidecarFile(join(dir, sidecarFilename))
    downloadedAtUtc = (await stat(join(dir, sidecarFilename))).mtime.toISOString()
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { status: 'none' }
    return { status: 'unusable', reason: 'the sidecar could not be read' }
  }

  const text = (key: string) => typeof sidecar[key] === 'string' ? sidecar[key] : null
  const source = new SourceIndex()
  source.add(tapeSourceRef(tape), tape.id)
  if (!source.has({ url: text('original_url') ?? text('webpage_url') ?? '', extractor: text('extractor'), sourceId: text('id') })) {
    return { status: 'unusable', reason: 'the sidecar belongs to another source' }
  }

  const names = await readdir(dir)
  const underStem = (name: string) => name.slice(0, name.length - extname(name).length) === stem
  const media = names.filter((name) => underStem(name) && !NOT_MEDIA.has(extname(name).toLowerCase()))
  if (media.length === 0) return { status: 'none' }
  if (media.length > 1) return { status: 'unusable', reason: 'more than one file could be the media' }
  const poster = `${stem}.jpg`
  const thumbnailFilename = names.includes(poster) && (await stat(join(dir, poster))).isFile() ? poster : null

  let found: Tape
  try {
    found = tapeFromSidecar(sidecar, {
      id: tape.id,
      sourceUrl: tape.sourceUrl,
      mediaFilename: media[0]!,
      sidecarFilename,
      thumbnailFilename,
      addedIndex: tape.addedIndex,
      nowUtc: downloadedAtUtc,
    })
  } catch {
    return { status: 'unusable', reason: 'the sidecar has invalid fields' }
  }
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
      downloadedAtUtc,
    },
  }
}
