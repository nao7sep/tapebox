import { basename, join } from 'node:path'
import { rename } from 'node:fs/promises'
import * as ytdlp from '@main/services/ytdlp'
import * as ffmpeg from '@main/services/ffmpeg'
import * as sidecar from '@main/core/sidecar'
import * as session from '@main/store/session'
import { getLibraryDir } from '@main/store/config'
import { emit } from '@main/ipc/events'
import { describeError } from '@shared/error'
import { log } from '@main/io/logger'
import { nowUtcIso } from '@shared/utc'
import type { Tape } from '@shared/domain'

const DOWNLOAD_FAILURE_MESSAGE =
  'The download could not be completed. Check the source and your connection, then try again.'
const DUPLICATE_FAILURE_MESSAGE = 'This video is already in the library, so it was not downloaded again.'

/**
 * Everything the job lifecycle reaches into the rest of the app for. Injected so
 * the probe -> download -> finalize state machine can be driven with fakes; the
 * production default ({@link defaultJobDeps}) binds these to the real services, so
 * the queue manager constructs jobs exactly as before.
 */
export interface JobDeps {
  ytdlp: {
    probe: typeof ytdlp.probe
    download: typeof ytdlp.download
    findThumbnail: typeof ytdlp.findThumbnail
  }
  ffmpeg: {
    probeMedia: typeof ffmpeg.probeMedia
    saveThumbnailJpeg: typeof ffmpeg.saveThumbnailJpeg
  }
  sidecar: { finalize: typeof sidecar.finalize }
  session: {
    getTape: typeof session.getTape
    getTapes: typeof session.getTapes
    upsertTape: typeof session.upsertTape
  }
  getLibraryDir: typeof getLibraryDir
  emit: typeof emit
  log: { info: typeof log.info; warn: typeof log.warn; error: typeof log.error }
  now: () => string
}

export const defaultJobDeps: JobDeps = {
  ytdlp: { probe: ytdlp.probe, download: ytdlp.download, findThumbnail: ytdlp.findThumbnail },
  ffmpeg: { probeMedia: ffmpeg.probeMedia, saveThumbnailJpeg: ffmpeg.saveThumbnailJpeg },
  sidecar: { finalize: sidecar.finalize },
  session: { getTape: session.getTape, getTapes: session.getTapes, upsertTape: session.upsertTape },
  getLibraryDir,
  emit,
  log: { info: log.info, warn: log.warn, error: log.error },
  now: nowUtcIso,
}

/**
 * Single job lifecycle: probe -> download -> finalize sidecar.
 *
 * Cancellation is awaitable: cancel() returns the same Promise that run()
 * returns. The queue manager awaits this when other handlers (library:remove,
 * downloads:cancel) need the yt-dlp process to be gone before they touch disk.
 */
export class Job {
  readonly tapeId: string
  private controller = new AbortController()
  private cancelled = false
  private runPromise: Promise<void> | null = null
  private readonly d: JobDeps

  constructor(tape: Tape, deps: JobDeps = defaultJobDeps) {
    this.tapeId = tape.id
    this.d = deps
  }

  /**
   * Request cancellation. Returns the run() promise so the caller can await
   * actual teardown (subprocess exit + finally blocks done). Safe to call
   * before run() begins or after it finishes — both cases resolve immediately.
   */
  cancel(): Promise<void> {
    this.cancelled = true
    this.controller.abort()
    return this.runPromise ?? Promise.resolve()
  }

  run(): Promise<void> {
    if (this.runPromise) return this.runPromise
    this.runPromise = this.runInner()
    return this.runPromise
  }

  private async runInner(): Promise<void> {
    // Fresh attempt: clear any log buffered from a prior (failed) run.
    this.d.emit('tapes:logReset', { tapeId: this.tapeId })
    try {
      const isVideo = await this.probe()
      if (!isVideo || this.cancelled) return
      await this.download()
    } catch (err) {
      if (this.cancelled) {
        this.update({ state: 'paused', failureCode: null, lastError: null, pausedAtUtc: this.d.now() })
        return
      }
      this.d.log.error('job failed', { tapeId: this.tapeId, error: describeError(err) })
      this.update({
        state: 'failed',
        failureCode: 'download',
        lastError: DOWNLOAD_FAILURE_MESSAGE,
        failedAtUtc: this.d.now(),
      })
      this.d.emit('tapes:failed', { tapeId: this.tapeId, code: 'download' })
    }
  }

  private current(): Tape | undefined {
    return this.d.session.getTape(this.tapeId)
  }

  private update(patch: Partial<Tape>): void {
    const cur = this.current()
    if (!cur) return
    const next = { ...cur, ...patch }
    this.d.session.upsertTape(next)
    this.d.emit('tapes:updated', next)
  }

  /** Returns true if a downloadable video; false if the URL is a page of videos. */
  private async probe(): Promise<boolean> {
    this.update({ state: 'probing' })
    const result = await this.d.ytdlp.probe(this.current()!.sourceUrl, this.controller.signal)
    if (result.kind === 'page') {
      this.update({ state: 'listing', failureCode: null, lastError: null, probedAtUtc: this.d.now() })
      return false
    }
    // Two URLs can resolve to the same video (e.g. a short share link and the
    // canonical page), and we don't want two library rows for one video. The id
    // is unique only within an extractor, so the identity is the (extractor, id)
    // pair — the same key its --download-archive uses. Only known post-probe, so
    // we catch it here.
    const duplicate = this.d.session
      .getTapes()
      .find((i) => i.id !== this.tapeId && i.sourceId === result.id && i.extractor === result.extractor)
    if (duplicate) {
      // A terminal outcome that bypasses the runInner() catch, so log it here —
      // otherwise a download that "failed" leaves no trace in the session log.
      this.d.log.info('job rejected: duplicate', { tapeId: this.tapeId, extractor: result.extractor, sourceId: result.id, duplicateOf: duplicate.id })
      this.update({
        state: 'failed',
        failureCode: 'duplicate',
        lastError: DUPLICATE_FAILURE_MESSAGE,
        failedAtUtc: this.d.now(),
        probedAtUtc: this.d.now(),
      })
      this.d.emit('tapes:failed', { tapeId: this.tapeId, code: 'duplicate' })
      return false
    }
    this.update({
      state: 'ready',
      failureCode: null,
      sourceId: result.id,
      extractor: result.extractor,
      title: result.title,
      uploader: result.uploader,
      durationSeconds: result.duration,
      chapterCount: result.chapters?.length ?? 0,
      probedAtUtc: this.d.now(),
    })
    return true
  }

  private async download(): Promise<void> {
    const cur = this.current()
    if (!cur || !cur.sourceId) throw new Error('Job: download called without sourceId')

    const libraryDir = this.d.getLibraryDir()

    this.update({ state: 'downloading', downloadStartedAtUtc: this.d.now() })

    // The tape's id is the on-disk stem — opaque and unique by construction, so
    // there's no source-id collision to dodge and no file to clobber.
    const stem = cur.id

    const result = await this.d.ytdlp.download({
      url: cur.sourceUrl,
      libraryDir,
      outputId: stem,
      signal: this.controller.signal,
      onProgress: (progress) => {
        this.d.emit('tapes:progress', { tapeId: this.tapeId, phase: 'downloading', ...progress })
      },
      onLog: (line) => {
        this.d.emit('tapes:log', { tapeId: this.tapeId, line })
      },
    })

    // yt-dlp should write straight into the library root via --paths, but if it
    // ever lands the media in a subdirectory, flatten it to {libraryDir}/{stem}.{ext}
    // so it sits beside its siblings. This is unexpected, so record it — and let a
    // failed move surface as a failed job (the runInner catch) rather than leaving a
    // tape whose filename points at a file that isn't there.
    const mediaBasename = basename(result.mediaPath)
    const expectedMediaPath = join(libraryDir, mediaBasename)
    if (result.mediaPath !== expectedMediaPath) {
      this.d.log.warn('yt-dlp wrote media outside the library root; relocating', {
        tapeId: this.tapeId,
        from: result.mediaPath,
        to: expectedMediaPath,
      })
      await rename(result.mediaPath, expectedMediaPath)
    }

    // Parse the actual file for reliable technical metadata — yt-dlp's info.json
    // is sparse for generic/direct downloads (sites without a dedicated
    // extractor). Best-effort: a probe failure just leaves it null.
    const media = await this.d.ffmpeg.probeMedia(expectedMediaPath, this.controller.signal).catch(() => null)

    // Normalize the source thumbnail (whatever format yt-dlp fetched) to our
    // canonical {stem}.jpg through the one image gate. The poster is a nice-to-have:
    // a thumbnail that can't be fetched or converted must never fail a download
    // whose media is already on disk — degrade to no poster and record why.
    let thumbnailFilename: string | null = null
    try {
      const rawThumb = await this.d.ytdlp.findThumbnail(libraryDir, stem)
      if (rawThumb) {
        thumbnailFilename = await this.d.ffmpeg.saveThumbnailJpeg(rawThumb, libraryDir, stem, this.controller.signal)
      }
    } catch (err) {
      this.d.log.warn('thumbnail skipped', { tapeId: this.tapeId, error: describeError(err) })
    }

    const sidecarFilename = `${stem}.json`
    const sidecarPath = join(libraryDir, sidecarFilename)

    await this.d.sidecar.finalize({
      infoJsonPath: result.infoJsonPath,
      sidecarPath,
      tapeboxAdditions: {
        sourceUrl: cur.sourceUrl,
        name: null,
        addedAtUtc: cur.addedAtUtc,
        downloadedAtUtc: this.d.now(),
        renamedAtUtc: null,
        media,
        mediaFilename: mediaBasename,
        thumbnailFilename,
      },
    })

    this.update({
      state: 'downloaded',
      failureCode: null,
      filename: mediaBasename,
      sidecarFilename,
      thumbnailFilename,
      downloadedAtUtc: this.d.now(),
    })
    // Close the bracket opened by 'job start': the queue logs start and the catch
    // logs failure, so without this the app's central operation — a finished
    // download — would be the one outcome absent from the session log.
    this.d.log.info('job done', { tapeId: this.tapeId, sourceId: cur.sourceId, filename: mediaBasename })
    this.d.emit('tapes:completed', { tapeId: this.tapeId })
  }
}
