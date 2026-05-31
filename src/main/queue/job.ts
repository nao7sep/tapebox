import { basename, join } from 'node:path'
import { rename } from 'node:fs/promises'
import * as ytdlp from '@main/services/ytdlp'
import * as ffmpeg from '@main/services/ffmpeg'
import * as sidecar from '@main/core/sidecar'
import * as session from '@main/store/session'
import { getSettings } from '@main/store/config'
import { emit } from '@main/ipc/events'
import { log } from '@main/io/logger'
import { nowUtcIso } from '@shared/utc'
import type { Item } from '@shared/domain'

/**
 * Single job lifecycle: probe -> download -> finalize sidecar.
 *
 * Cancellation is awaitable: cancel() returns the same Promise that run()
 * returns. The queue manager awaits this when other handlers (library:remove,
 * downloads:cancel) need the yt-dlp process to be gone before they touch disk.
 */
export class Job {
  readonly itemId: string
  private controller = new AbortController()
  private cancelled = false
  private runPromise: Promise<void> | null = null

  constructor(item: Item) {
    this.itemId = item.id
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
    try {
      const isVideo = await this.probe()
      if (!isVideo || this.cancelled) return
      await this.download()
    } catch (err) {
      if (this.cancelled) {
        this.update({ state: 'paused', lastError: null, pausedAtUtc: nowUtcIso() })
        return
      }
      const message = String(err)
      log.error(`job failed: ${this.itemId}`, { error: message })
      this.update({ state: 'failed', lastError: message, failedAtUtc: nowUtcIso() })
      emit('items:failed', { itemId: this.itemId, error: message })
    }
  }

  private current(): Item | undefined {
    return session.getItem(this.itemId)
  }

  private update(patch: Partial<Item>): void {
    const cur = this.current()
    if (!cur) return
    const next = { ...cur, ...patch }
    session.upsertItem(next)
    emit('items:updated', next)
  }

  /** Returns true if a downloadable video; false if the URL is a playlist. */
  private async probe(): Promise<boolean> {
    this.update({ state: 'probing' })
    const result = await ytdlp.probe(this.current()!.sourceUrl, this.controller.signal)
    if (result.kind === 'playlist') {
      this.update({ state: 'playlist', lastError: null, probedAtUtc: nowUtcIso() })
      return false
    }
    this.update({
      state: 'ready',
      sourceId: result.id,
      title: result.title,
      originalTitle: result.originalTitle,
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
    // Start every attempt from a clean slate: a leftover .part from a prior
    // failed/cancelled run can be stale or oversized and makes yt-dlp's resume
    // fail with HTTP 416. yt-dlp re-fetches the incomplete stream (completed
    // sub-streams are kept and reused); within an attempt, its own retries and
    // our stall-retry still resume the in-progress file.
    await ytdlp.clearPartials(settings.libraryDir, cur.sourceId)

    this.update({ state: 'downloading', downloadStartedAtUtc: nowUtcIso() })

    const result = await ytdlp.download({
      url: cur.sourceUrl,
      libraryDir: settings.libraryDir,
      outputId: cur.sourceId,
      signal: this.controller.signal,
      onProgress: (percent) => {
        emit('items:progress', { itemId: this.itemId, phase: 'downloading', percent })
      },
    })

    // Parse the actual file for reliable technical metadata — yt-dlp's info.json
    // is sparse for generic/direct downloads (sites without a dedicated
    // extractor). Best-effort: a probe failure just leaves it null.
    const media = await ffmpeg.probeMedia(result.mediaPath).catch(() => null)

    const sidecarFilename = `${cur.sourceId}.json`
    const sidecarPath = join(settings.libraryDir, sidecarFilename)

    await sidecar.finalize({
      infoJsonPath: result.infoJsonPath,
      sidecarPath,
      tapeboxAdditions: {
        schemaVersion: 1,
        sourceUrl: cur.sourceUrl,
        originalTitle: cur.originalTitle,
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
    emit('items:completed', { itemId: this.itemId })
  }
}
