import { basename, join } from 'node:path'
import { rename } from 'node:fs/promises'
import * as ytdlp from '@main/services/ytdlp'
import * as ffmpeg from '@main/services/ffmpeg'
import * as sidecar from '@main/core/sidecar'
import * as session from '@main/store/session'
import { getSettings } from '@main/store/config'
import { emit } from '@main/ipc/events'
import { describeError, errorMessage } from '@main/io/spawn'
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
      log.error(`job failed: ${this.tapeId}`, describeError(err))
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
    // Two URLs can resolve to the same video (e.g. youtu.be/X vs watch?v=X). The
    // on-disk name is the video id, so downloading both would collide on
    // <id>.<ext>/<id>.json. The id is only known now (post-probe), so this is
    // where we catch it — halt with a clear message rather than clobber files.
    const duplicate = session.getTapes().find((i) => i.id !== this.tapeId && i.sourceId === result.id)
    if (duplicate) {
      this.update({
        state: 'failed',
        lastError: `Duplicate of an existing tape (same video id ${result.id}). Not downloaded to avoid a file collision.`,
        failedAtUtc: nowUtcIso(),
        probedAtUtc: nowUtcIso(),
      })
      return false
    }
    this.update({
      state: 'ready',
      sourceId: result.id,
      title: result.title,
      uploader: result.uploader,
      durationSeconds: result.duration,
      chapterCount: result.chapters?.length ?? 0,
      thumbnailUrl: result.thumbnail,
      probedAtUtc: nowUtcIso(),
    })
    return true
  }

  private async download(): Promise<void> {
    const cur = this.current()
    if (!cur || !cur.sourceId) throw new Error('Job: download called without sourceId')

    const settings = getSettings()

    this.update({ state: 'downloading', downloadStartedAtUtc: nowUtcIso() })

    const result = await ytdlp.download({
      url: cur.sourceUrl,
      libraryDir: settings.libraryDir,
      outputId: cur.sourceId,
      signal: this.controller.signal,
      onProgress: (progress) => {
        emit('tapes:progress', { tapeId: this.tapeId, phase: 'downloading', ...progress })
      },
      onLog: (line) => {
        emit('tapes:log', { tapeId: this.tapeId, line })
      },
    })

    // Parse the actual file for reliable technical metadata — yt-dlp's info.json
    // is sparse for generic/direct downloads (sites without a dedicated
    // extractor). Best-effort: a probe failure just leaves it null.
    const media = await ffmpeg.probeMedia(result.mediaPath, this.controller.signal).catch(() => null)

    const sidecarFilename = `${cur.sourceId}.json`
    const sidecarPath = join(settings.libraryDir, sidecarFilename)

    await sidecar.finalize({
      infoJsonPath: result.infoJsonPath,
      sidecarPath,
      tapeboxAdditions: {
        sourceUrl: cur.sourceUrl,
        slug: null,
        addedAtUtc: cur.addedAtUtc,
        downloadedAtUtc: nowUtcIso(),
        renamedAtUtc: null,
        media,
      },
    })

    // If yt-dlp wrote into a subdirectory (it shouldn't with our --paths), flatten.
    const mediaBasename = basename(result.mediaPath)
    const expectedMediaPath = join(settings.libraryDir, mediaBasename)
    if (result.mediaPath !== expectedMediaPath) {
      await rename(result.mediaPath, expectedMediaPath).catch(() => {})
    }

    this.update({
      state: 'downloaded',
      filename: mediaBasename,
      sidecarFilename,
      downloadedAtUtc: nowUtcIso(),
    })
    emit('tapes:completed', { tapeId: this.tapeId })
  }
}
