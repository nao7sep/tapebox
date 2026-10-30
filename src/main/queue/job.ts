import { basename, join } from 'node:path'
import { mkdir, rename } from 'node:fs/promises'
import { tapeDir } from '@main/paths'
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
import { moveTape, type TapeMove } from '@main/core/tape-state'
import { StopRequest, type StopCause } from '@main/stop-request'
import { findFinishedBundle } from '@main/queue/finished-bundle'
import { withLibraryTurn } from '@main/library-writes'

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
  findFinishedBundle: typeof findFinishedBundle
  session: {
    sourceOwner: typeof session.sourceOwner
    getTape: typeof session.getTape
    upsertTape: typeof session.upsertTape
    persistNow: typeof session.persistNow
  }
  getLibraryDir: typeof getLibraryDir
  withLibraryTurn: typeof withLibraryTurn
  emit: typeof emit
  log: { info: typeof log.info; warn: typeof log.warn; error: typeof log.error }
  now: () => string
}

export const defaultJobDeps: JobDeps = {
  ytdlp: { probe: ytdlp.probe, download: ytdlp.download, findThumbnail: ytdlp.findThumbnail },
  ffmpeg: { probeMedia: ffmpeg.probeMedia, saveThumbnailJpeg: ffmpeg.saveThumbnailJpeg },
  sidecar: { finalize: sidecar.finalize },
  findFinishedBundle,
  session: {
    sourceOwner: session.sourceOwner,
    getTape: session.getTape,
    upsertTape: session.upsertTape,
    persistNow: session.persistNow,
  },
  getLibraryDir,
  withLibraryTurn,
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
  // The abort reason says who stopped the job: a stop at quit leaves the tape's
  // persisted state alone so it resumes on the next launch; a user cancel parks
  // it as paused.
  private controller = new AbortController()
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
    return this.abort('cancel')
  }

  /**
   * Quit-time teardown: abort like {@link cancel}, but without the paused
   * transition. The tape keeps its in-flight state, and the next launch returns
   * it to the queue.
   */
  stop(): Promise<void> {
    return this.abort('quit')
  }

  private abort(by: StopCause): Promise<void> {
    this.controller.abort(new StopRequest(by))
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
      // Recovery and a new attempt both work in the tape's own folder, whose
      // files no other tape can name.
      if (await this.d.withLibraryTurn(() => this.adoptFinishedDownload())) return
      const isVideo = await this.probe()
      if (!isVideo || this.controller.signal.aborted) return
      await this.download()
    } catch (err) {
      const { aborted, reason } = this.controller.signal
      if (aborted && reason instanceof StopRequest && reason.by === 'quit') return
      if (aborted) {
        this.update({ state: 'paused', failureCode: null, lastError: null })
        return
      }
      this.d.log.error('job failed', { tapeId: this.tapeId, error: describeError(err) })
      this.update({
        state: 'failed',
        failureCode: 'download',
        lastError: DOWNLOAD_FAILURE_MESSAGE,
      })
      this.d.emit('tapes:failed', { tapeId: this.tapeId, code: 'download' })
    }
  }

  private current(): Tape | undefined {
    return this.d.session.getTape(this.tapeId)
  }

  /** Move the tape to a new state at `at`, by default the moment of the move. */
  private update(move: TapeMove, at: string = this.d.now()): void {
    const next = this.move(move, at)
    if (next) this.d.emit('tapes:updated', next)
  }

  /** Apply a move to the session without telling the window. */
  private move(move: TapeMove, at: string = this.d.now()): Tape | null {
    const cur = this.current()
    if (!cur) return null
    const next = moveTape(cur, move, at)
    this.d.session.upsertTape(next)
    return next
  }

  /**
   * Adopt a download that finished on disk before its catalog commit landed,
   * instead of probing and downloading again over it (queue/finished-bundle.ts).
   * Returns true once the job is settled: adopted, or failed with the files kept.
   * Runs at a library turn, so no file action changes ownership meanwhile.
   */
  private async adoptFinishedDownload(): Promise<boolean> {
    const cur = this.current()
    if (!cur) return false
    const found = await this.d.findFinishedBundle(tapeDir(this.d.getLibraryDir(), cur.id), cur)
    if (found.status === 'none') return false
    if (found.status === 'unusable') {
      // Clearing the stem for a new attempt could delete a finished download, so
      // the files stay and the tape fails; removing it is the user's call.
      this.d.log.error('job stopped: a finished download for this tape could not be adopted', { tapeId: this.tapeId, reason: found.reason })
      this.update({ state: 'failed', failureCode: 'download', lastError: DOWNLOAD_FAILURE_MESSAGE })
      this.d.emit('tapes:failed', { tapeId: this.tapeId, code: 'download' })
      return true
    }
    this.controller.signal.throwIfAborted()
    this.move(found.move)
    const committed = await this.d.session.persistNow()
    const adopted = this.current()
    this.d.log.info('job adopted a finished download', { tapeId: this.tapeId, filename: adopted?.filename ?? null, committed })
    try {
      if (adopted) this.d.emit('tapes:updated', adopted)
      this.d.emit('tapes:completed', { tapeId: this.tapeId })
    } catch (err) {
      this.d.log.error('download completion could not be sent to the window', { tapeId: this.tapeId, error: describeError(err) })
    }
    return true
  }

  /** Returns true if a downloadable video; false if the URL is a page of videos. */
  private async probe(): Promise<boolean> {
    this.update({ state: 'probing' })
    const result = await this.d.ytdlp.probe(this.tapeId, this.current()!.sourceUrl, this.controller.signal)
    // One time for the probe's answer and whatever it decides.
    const probedAtUtc = this.d.now()
    if (result.kind === 'page') {
      this.update({ state: 'listing', failureCode: null, lastError: null, probedAtUtc })
      return false
    }
    // Two URLs can resolve to the same video (e.g. a short share link and the
    // canonical page), and we don't want two library rows for one video. The
    // (extractor, id) pair is only known post-probe, so the library's identity
    // rule is checked again here with it.
    const duplicateOf = this.d.session.sourceOwner({
      url: this.current()!.sourceUrl,
      extractor: result.extractor,
      sourceId: result.id,
    }, this.tapeId)
    if (duplicateOf) {
      // A terminal outcome that bypasses the runInner() catch, so log it here —
      // otherwise a download that "failed" leaves no trace in the session log.
      this.d.log.info('job rejected: duplicate', { tapeId: this.tapeId, extractor: result.extractor, sourceId: result.id, duplicateOf })
      this.update({
        state: 'failed',
        failureCode: 'duplicate',
        lastError: DUPLICATE_FAILURE_MESSAGE,
        probedAtUtc,
      }, probedAtUtc)
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
      probedAtUtc,
    })
    return true
  }

  private async download(): Promise<void> {
    const cur = this.current()
    if (!cur || !cur.sourceId) throw new Error('Job: download called without sourceId')

    // The tape's own folder holds the download, its partial files and its poster.
    const dir = tapeDir(this.d.getLibraryDir(), cur.id)
    await mkdir(dir, { recursive: true })

    this.update({ state: 'downloading', downloadStartedAtUtc: this.d.now() })

    // The tape's id is the on-disk stem — opaque and unique by construction, so
    // there's no source-id collision to dodge and no file to clobber.
    const stem = cur.id

    const result = await this.d.ytdlp.download({
      tapeId: this.tapeId,
      url: cur.sourceUrl,
      dir,
      outputId: stem,
      signal: this.controller.signal,
      onProgress: (progress) => {
        this.d.emit('tapes:progress', { tapeId: this.tapeId, phase: 'downloading', ...progress })
      },
      onLog: (line) => {
        this.d.emit('tapes:log', { tapeId: this.tapeId, line })
      },
      onStall: (stalled) => {
        this.d.emit('tapes:stalled', { tapeId: this.tapeId, stalled })
      },
    })

    // yt-dlp should write straight into the tape's folder via --paths, but if it
    // ever lands the media in a subdirectory, flatten it to {dir}/{stem}.{ext}
    // so it sits beside its siblings. This is unexpected, so record it — and let a
    // failed move surface as a failed job (the runInner catch) rather than leaving a
    // tape whose filename points at a file that isn't there.
    const mediaBasename = basename(result.mediaPath)
    const expectedMediaPath = join(dir, mediaBasename)
    if (result.mediaPath !== expectedMediaPath) {
      this.d.log.warn('yt-dlp wrote media outside the tape folder; relocating', {
        tapeId: this.tapeId,
        from: result.mediaPath,
        to: expectedMediaPath,
      })
      await rename(result.mediaPath, expectedMediaPath)
    }

    // Parse the actual file for reliable technical metadata — yt-dlp's info.json
    // is sparse for generic/direct downloads (sites without a dedicated
    // extractor). Best-effort: a probe failure just leaves it null.
    const media = await this.d.ffmpeg.probeMedia(this.tapeId, expectedMediaPath, this.controller.signal).catch(() => null)

    // Normalize the source thumbnail (whatever format yt-dlp fetched) to our
    // canonical {stem}.jpg through the one image gate. The poster is a nice-to-have:
    // a thumbnail that can't be fetched or converted must never fail a download
    // whose media is already on disk — degrade to no poster and record why.
    let thumbnailFilename: string | null = null
    try {
      const rawThumb = await this.d.ytdlp.findThumbnail(dir, stem)
      if (rawThumb) {
        thumbnailFilename = await this.d.ffmpeg.saveThumbnailJpeg(this.tapeId, rawThumb, dir, stem, this.controller.signal)
      }
    } catch (err) {
      this.d.log.warn('thumbnail skipped', { tapeId: this.tapeId, error: describeError(err) })
    }

    const sidecarFilename = `${stem}.json`
    const sidecarPath = join(dir, sidecarFilename)
    await this.d.sidecar.finalize({ infoJsonPath: result.infoJsonPath, sidecarPath, media })
    const downloadedAtUtc = this.d.now()

    // The finished files are on disk; adding them to the library is this job's
    // one library turn. Commit the row that names them before reporting success,
    // so a crash now cannot restore the tape as queued and have its next attempt
    // delete the finished download. The download is done either way: a failed
    // catalog write is the session store's to retry and report, never a download
    // failure that would invite a Retry over these files.
    const committed = await this.d.withLibraryTurn(() => {
      this.move({
        state: 'downloaded',
        failureCode: null,
        filename: mediaBasename,
        sidecarFilename,
        thumbnailFilename,
        downloadedAtUtc,
      })
      return this.d.session.persistNow()
    })
    // Close the bracket opened by 'job start': the queue logs start and the catch
    // logs failure, so without this the app's central operation — a finished
    // download — would be the one outcome absent from the session log.
    this.d.log.info('job done', { tapeId: this.tapeId, sourceId: cur.sourceId, filename: mediaBasename, committed })
    // Telling the window comes last and cannot undo the download: a failed send
    // is logged here, never caught as a download failure that would mark failed a
    // tape that names its finished files.
    try {
      const finished = this.current()
      if (finished) this.d.emit('tapes:updated', finished)
      this.d.emit('tapes:completed', { tapeId: this.tapeId })
    } catch (err) {
      this.d.log.error('download completion could not be sent to the window', {
        tapeId: this.tapeId,
        error: describeError(err),
      })
    }
  }
}
