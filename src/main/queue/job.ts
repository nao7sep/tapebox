import { basename, join } from 'node:path'
import { rename } from 'node:fs/promises'
import * as ytdlp from '@main/services/ytdlp'
import * as ffmpeg from '@main/services/ffmpeg'
import * as sidecar from '@main/core/sidecar'
import * as session from '@main/store/session'
import { getSettings } from '@main/store/config'
import { emit } from '@main/ipc/events'
import { describeError, errorMessage } from '@shared/error'
import { log } from '@main/io/logger'
import { nowUtcIso } from '@shared/utc'
import type { Tape } from '@shared/domain'

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

  constructor(tape: Tape) {
    this.tapeId = tape.id
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
    emit('tapes:logReset', { tapeId: this.tapeId })
    try {
      const isVideo = await this.probe()
      if (!isVideo || this.cancelled) return
      await this.download()
    } catch (err) {
      if (this.cancelled) {
        this.update({ state: 'paused', lastError: null, pausedAtUtc: nowUtcIso() })
        return
      }
      const message = errorMessage(err)
      log.error('job failed', { tapeId: this.tapeId, error: describeError(err) })
      this.update({ state: 'failed', lastError: message, failedAtUtc: nowUtcIso() })
      emit('tapes:failed', { tapeId: this.tapeId, error: message })
    }
  }

  private current(): Tape | undefined {
    return session.getTape(this.tapeId)
  }

  private update(patch: Partial<Tape>): void {
    const cur = this.current()
    if (!cur) return
    const next = { ...cur, ...patch }
    session.upsertTape(next)
    emit('tapes:updated', next)
  }

  /** Returns true if a downloadable video; false if the URL is a page of videos. */
  private async probe(): Promise<boolean> {
    this.update({ state: 'probing' })
    const result = await ytdlp.probe(this.current()!.sourceUrl, this.controller.signal)
    if (result.kind === 'page') {
      this.update({ state: 'listing', lastError: null, probedAtUtc: nowUtcIso() })
      return false
    }
    // Two URLs can resolve to the same video (e.g. a short share link and the
    // canonical page), and we don't want two library rows for one video. The id
    // is unique only within an extractor, so the identity is the (extractor, id)
    // pair — the same key its --download-archive uses. Only known post-probe, so
    // we catch it here.
    const duplicate = session
      .getTapes()
      .find((i) => i.id !== this.tapeId && i.sourceId === result.id && i.extractor === result.extractor)
    if (duplicate) {
      // A terminal outcome that bypasses the runInner() catch, so log it here —
      // otherwise a download that "failed" leaves no trace in the session log.
      log.info('job rejected: duplicate', { tapeId: this.tapeId, extractor: result.extractor, sourceId: result.id, duplicateOf: duplicate.id })
      this.update({
        state: 'failed',
        lastError: `Duplicate of an existing tape (same video). Not downloaded again.`,
        failedAtUtc: nowUtcIso(),
        probedAtUtc: nowUtcIso(),
      })
      return false
    }
    this.update({
      state: 'ready',
      sourceId: result.id,
      extractor: result.extractor,
      title: result.title,
      uploader: result.uploader,
      durationSeconds: result.duration,
      chapterCount: result.chapters?.length ?? 0,
      probedAtUtc: nowUtcIso(),
    })
    return true
  }

  private async download(): Promise<void> {
    const cur = this.current()
    if (!cur || !cur.sourceId) throw new Error('Job: download called without sourceId')

    const settings = getSettings()

    this.update({ state: 'downloading', downloadStartedAtUtc: nowUtcIso() })

    // The tape's id is the on-disk stem — opaque and unique by construction, so
    // there's no source-id collision to dodge and no file to clobber.
    const stem = cur.id

    const result = await ytdlp.download({
      url: cur.sourceUrl,
      libraryDir: settings.libraryDir,
      outputId: stem,
      signal: this.controller.signal,
      onProgress: (progress) => {
        emit('tapes:progress', { tapeId: this.tapeId, phase: 'downloading', ...progress })
      },
      onLog: (line) => {
        emit('tapes:log', { tapeId: this.tapeId, line })
      },
    })

    // If yt-dlp wrote into a subdirectory (it shouldn't with our --paths), flatten
    // the media so it sits at {libraryDir}/{stem}.{ext} like its siblings.
    const mediaBasename = basename(result.mediaPath)
    const expectedMediaPath = join(settings.libraryDir, mediaBasename)
    if (result.mediaPath !== expectedMediaPath) {
      await rename(result.mediaPath, expectedMediaPath).catch(() => {})
    }

    // Parse the actual file for reliable technical metadata — yt-dlp's info.json
    // is sparse for generic/direct downloads (sites without a dedicated
    // extractor). Best-effort: a probe failure just leaves it null.
    const media = await ffmpeg.probeMedia(expectedMediaPath, this.controller.signal).catch(() => null)

    // Normalize the source thumbnail (whatever format yt-dlp fetched) to our
    // canonical {stem}.jpg through the one image gate. The poster is a nice-to-have:
    // a thumbnail that can't be fetched or converted must never fail a download
    // whose media is already on disk — degrade to no poster and record why.
    let thumbnailFilename: string | null = null
    try {
      const rawThumb = await ytdlp.findThumbnail(settings.libraryDir, stem)
      if (rawThumb) {
        thumbnailFilename = await ffmpeg.saveThumbnailJpeg(rawThumb, settings.libraryDir, stem, this.controller.signal)
      }
    } catch (err) {
      log.warn('thumbnail skipped', { tapeId: this.tapeId, error: describeError(err) })
    }

    const sidecarFilename = `${stem}.json`
    const sidecarPath = join(settings.libraryDir, sidecarFilename)

    await sidecar.finalize({
      infoJsonPath: result.infoJsonPath,
      sidecarPath,
      tapeboxAdditions: {
        sourceUrl: cur.sourceUrl,
        name: null,
        addedAtUtc: cur.addedAtUtc,
        downloadedAtUtc: nowUtcIso(),
        renamedAtUtc: null,
        media,
        mediaFilename: mediaBasename,
        thumbnailFilename,
      },
    })

    this.update({
      state: 'downloaded',
      filename: mediaBasename,
      sidecarFilename,
      thumbnailFilename,
      downloadedAtUtc: nowUtcIso(),
    })
    // Close the bracket opened by 'job start': the queue logs start and the catch
    // logs failure, so without this the app's central operation — a finished
    // download — would be the one outcome absent from the session log.
    log.info('job done', { tapeId: this.tapeId, sourceId: cur.sourceId, filename: mediaBasename })
    emit('tapes:completed', { tapeId: this.tapeId })
  }
}
