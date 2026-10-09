import { mkdtemp, readdir, readFile, rm, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Job, type JobDeps } from '@main/queue/job'
import { findFinishedBundle } from '@main/queue/finished-bundle'
import { finalize } from '@main/core/sidecar'
import { clearStem } from '@main/services/ytdlp'
import type { Tape } from '@shared/domain'

// A download that finished on disk while its catalog commit failed must survive
// the next attempt: the files are real, the queued row is what a relaunch reads.
// The sidecar, the bundle finder and the stem sweep are the real ones.

const ADDED = '2026-01-01T00:00:00.000Z'
const FINISHED = '2026-06-26T00:00:00.000Z'
const LATER = '2026-06-27T00:00:00.000Z'

let dir: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'tapebox-finished-bundle-'))
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

function queued(id: string): Tape {
  return {
    id, sourceUrl: 'https://example.test/watch', state: 'queued', addedAtUtc: ADDED,
    sourceId: null, extractor: null, title: null, uploader: null, durationSeconds: null, chapterCount: 0,
    probedAtUtc: null, filename: null, sidecarFilename: null, thumbnailFilename: null,
    downloadStartedAtUtc: null, downloadedAtUtc: null, name: null, renamedAtUtc: null,
    archivedAtUtc: null, boxId: null, order: 3, pausedAtUtc: null, failedAtUtc: null, failureCode: null, lastError: null,
  }
}

function deps(tapes: Map<string, Tape>, overrides: { download: JobDeps['ytdlp']['download']; probe: JobDeps['ytdlp']['probe']; committed: boolean; now: string }): JobDeps {
  const noop = (): void => {}
  return {
    ytdlp: { probe: overrides.probe, download: overrides.download, findThumbnail: async (libraryDir, stem) => join(libraryDir, `${stem}.webp`) },
    ffmpeg: {
      probeMedia: async () => ({ width: null, height: null, fps: null, vcodec: null, acodec: null, durationSeconds: null, bitrateKbps: null }),
      saveThumbnailJpeg: async (_tapeId, raw, libraryDir, stem) => {
        await writeFile(join(libraryDir, `${stem}.jpg`), 'poster')
        await unlink(raw)
        return `${stem}.jpg`
      },
    },
    sidecar: { finalize },
    findFinishedBundle,
    session: {
      getTape: (id) => tapes.get(id),
      getTapes: () => [...tapes.values()],
      upsertTape: (tape) => { tapes.set(tape.id, tape) },
      persistNow: async () => overrides.committed,
    },
    getLibraryDir: () => dir,
    emit: noop as JobDeps['emit'],
    log: { info: noop, warn: noop, error: noop },
    now: () => overrides.now,
  }
}

const video = {
  kind: 'video' as const, id: 'vid1', extractor: 'youtube', title: 'A Video', uploader: 'Someone',
  description: null, duration: 12, chapters: null,
}

describe('a download finished before its catalog commit', () => {
  it('survives the next attempt and reads as downloaded', async () => {
    const id = 'Crashed001'
    const first = new Map([[id, queued(id)]])
    await new Job(queued(id), deps(first, {
      probe: async () => video,
      download: async ({ libraryDir, outputId }) => {
        await writeFile(join(libraryDir, `${outputId}.mp4`), 'finished media')
        await writeFile(join(libraryDir, `${outputId}.webp`), 'raw poster')
        await writeFile(join(libraryDir, `${outputId}.info.json`), JSON.stringify({ id: 'vid1', extractor: 'youtube', title: 'A Video', uploader: 'Someone', duration: 12 }))
        return { mediaPath: join(libraryDir, `${outputId}.mp4`), infoJsonPath: join(libraryDir, `${outputId}.info.json`) }
      },
      committed: false,
      now: FINISHED,
    })).run()
    expect(first.get(id)?.state, 'finished in memory, but the commit failed').toBe('downloaded')

    // The relaunch reads the last committed row: the tape as it was queued.
    const relaunched = new Map([[id, queued(id)]])
    let attempted = false
    await new Job(queued(id), deps(relaunched, {
      probe: async () => { throw new Error('the source is gone') },
      download: async ({ libraryDir, outputId }) => {
        attempted = true
        await clearStem(libraryDir, outputId)
        throw new Error('the source is gone')
      },
      committed: true,
      now: LATER,
    })).run()

    expect(attempted).toBe(false)
    expect((await readdir(dir)).sort()).toEqual([`${id}.jpg`, `${id}.json`, `${id}.mp4`])
    expect(await readFile(join(dir, `${id}.mp4`), 'utf8')).toBe('finished media')
    expect(relaunched.get(id)).toMatchObject({
      state: 'downloaded', filename: `${id}.mp4`, sidecarFilename: `${id}.json`, thumbnailFilename: `${id}.jpg`,
      downloadedAtUtc: FINISHED, sourceId: 'vid1', extractor: 'youtube', title: 'A Video', durationSeconds: 12,
      order: 3, addedAtUtc: ADDED, failureCode: null,
    })
  })
})

describe('findFinishedBundle', () => {
  const sidecar = (id: string, fields: Record<string, unknown> = {}) => JSON.stringify({
    formatVersion: 1, id: 'vid1',
    tapebox: { sourceUrl: 'https://example.test/watch', addedAtUtc: ADDED, downloadedAtUtc: FINISHED, mediaFilename: `${id}.mp4`, thumbnailFilename: null, ...fields },
  })

  it('finds nothing without a sidecar under the tape\'s stem', async () => {
    await writeFile(join(dir, 'Nosidecar1.mp4.part'), 'partial')
    expect(await findFinishedBundle(dir, queued('Nosidecar1'), LATER)).toEqual({ status: 'none' })
  })

  it('finds nothing to protect when the sidecar names no media on disk', async () => {
    await writeFile(join(dir, 'Nomedia001.json'), sidecar('Nomedia001'))
    expect(await findFinishedBundle(dir, queued('Nomedia001'), LATER)).toEqual({ status: 'none' })
  })

  it('reports a sidecar it cannot adopt, leaving it in place', async () => {
    const text = JSON.stringify({ formatVersion: 99, tapebox: {} })
    await writeFile(join(dir, 'Newer00001.json'), text)
    await writeFile(join(dir, 'Newer00001.mp4'), 'media')
    expect(await findFinishedBundle(dir, queued('Newer00001'), LATER)).toMatchObject({ status: 'unusable' })
    expect(await readFile(join(dir, 'Newer00001.json'), 'utf8')).toBe(text)
  })

  it('refuses a sidecar that names another stem\'s media', async () => {
    await writeFile(join(dir, 'Ownstem001.json'), JSON.stringify({ ...JSON.parse(sidecar('Ownstem001')), tapebox: { ...JSON.parse(sidecar('Other00001')).tapebox } }))
    await writeFile(join(dir, 'Other00001.mp4'), 'media')
    expect(await findFinishedBundle(dir, queued('Ownstem001'), LATER)).toMatchObject({ status: 'unusable' })
  })

  it('drops a poster the sidecar names but the library lacks', async () => {
    await writeFile(join(dir, 'Noposter01.json'), sidecar('Noposter01', { thumbnailFilename: 'Noposter01.jpg' }))
    await writeFile(join(dir, 'Noposter01.mp4'), 'media')
    expect(await findFinishedBundle(dir, queued('Noposter01'), LATER)).toMatchObject({
      status: 'found', move: { filename: 'Noposter01.mp4', thumbnailFilename: null, downloadedAtUtc: FINISHED },
    })
  })
})
