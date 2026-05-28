import { basename, join } from 'node:path'
import { rename } from 'node:fs/promises'
import * as ytdlp from '@main/services/ytdlp'
import * as sidecar from '@main/core/sidecar'
import * as session from '@main/store/session'
import { getSettings } from '@main/store/config'
import { emit } from '@main/ipc/events'
import { log } from '@main/io/logger'
import { nowUtcIso } from '@shared/utc'
import type { Item } from '@shared/domain'

/**
 * Single job lifecycle: probe -> download -> finalize sidecar.
 * Owns one AbortController; cancel() aborts the chain at the next yt-dlp
 * boundary. Persists item updates and emits events at every transition.
 */
export class Job {
  readonly itemId: string
  private controller = new AbortController()
  private cancelled = false

  constructor(item: Item) {
    this.itemId = item.id
  }

  cancel(): void {
    this.cancelled = true
    this.controller.abort()
  }

  async run(): Promise<void> {
    try {
      await this.probe()
      if (this.cancelled) return
      await this.download()
    } catch (err) {
      if (this.cancelled) {
        this.update({ state: 'paused', lastError: null })
        return
      }
      const message = String(err)
      log.error(`job failed: ${this.itemId}`, { error: message })
      this.update({ state: 'failed', lastError: message })
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

  private async probe(): Promise<void> {
    this.update({ state: 'probing' })
    const result = await ytdlp.probe(this.current()!.sourceUrl, this.controller.signal)
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
  }

  private async download(): Promise<void> {
    const cur = this.current()
    if (!cur || !cur.sourceId) throw new Error('Job: download called without sourceId')

    this.update({ state: 'downloading' })

    const settings = getSettings()
    const result = await ytdlp.download({
      url: cur.sourceUrl,
      libraryDir: settings.libraryDir,
      outputId: cur.sourceId,
      signal: this.controller.signal,
      onProgress: (percent) => {
        emit('items:progress', { itemId: this.itemId, phase: 'downloading', percent })
      },
    })

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
        slugSource: null,
        addedAtUtc: cur.addedAtUtc,
        downloadedAtUtc: nowUtcIso(),
        renamedAtUtc: null,
        slugGeneratedAtUtc: null,
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
