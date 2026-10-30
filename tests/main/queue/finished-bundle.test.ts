import { collectionSourceIndex } from '@shared/source-identity'
import { mkdir, mkdtemp, readdir, readFile, rm, unlink, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Job, type JobDeps } from '@main/queue/job'
import { findFinishedBundle } from '@main/queue/finished-bundle'
import { finalize } from '@main/core/sidecar'
import { clearStem } from '@main/services/ytdlp'
import type { Tape } from '@shared/domain'

// A download that finished on disk while its tape.json commit failed must survive
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
    id, sourceUrl: 'https://example.test/watch', state: 'queued', addedAtUtc: ADDED, addedIndex: 3,
    sourceId: null, extractor: null, title: null, uploader: null, durationSeconds: null, chapterCount: 0,
    probedAtUtc: null, filename: null, sidecarFilename: null, thumbnailFilename: null,
    downloadStartedAtUtc: null, downloadedAtUtc: null, name: null, renamedAtUtc: null,
    shelved: false, boxId: null, order: 0, pausedAtUtc: null, failedAtUtc: null, failureCode: null, lastError: null,
  }
}

function deps(tapes: Map<string, Tape>, overrides: { download: JobDeps['ytdlp']['download']; probe: JobDeps['ytdlp']['probe']; committed: boolean; now: string }): JobDeps {
  const noop = (): void => {}
  return {
    ytdlp: { probe: overrides.probe, download: overrides.download, findThumbnail: async (folder, stem) => join(folder, `${stem}.webp`) },
    ffmpeg: {
      probeMedia: async () => ({ width: null, height: null, fps: null, vcodec: null, acodec: null, durationSeconds: null, bitrateKbps: null }),
      saveThumbnailJpeg: async (_tapeId, raw, folder, stem) => {
        await writeFile(join(folder, `${stem}.jpg`), 'poster')
        await unlink(raw)
        return `${stem}.jpg`
      },
    },
    sidecar: { finalize },
    findFinishedBundle,
    session: {
      getTape: (id) => tapes.get(id),
      sourceOwner: (ref, exceptId) => collectionSourceIndex([...tapes.values()], exceptId).find(ref),
      upsertTape: (tape) => { tapes.set(tape.id, tape) },
      persistNow: async () => overrides.committed,
    },
    getCollectionDir: () => dir,
    withCollectionTurn: (work) => work(dir),
    emit: noop as JobDeps['emit'],
    log: { info: noop, warn: noop, error: noop },
    now: () => overrides.now,
  }
}

const video = {
  kind: 'video' as const, id: 'vid1', extractor: 'youtube', title: 'A Video', uploader: 'Someone',
  description: null, duration: 12, chapters: null,
}

describe('a download finished before its tape file commit', () => {
  it('survives the next attempt and reads as downloaded', async () => {
    const id = 'Crashed001'
    const first = new Map([[id, queued(id)]])
    await new Job(queued(id), deps(first, {
      probe: async () => video,
      download: async ({ dir: folder, outputId }) => {
        await writeFile(join(folder, `${outputId}.mp4`), 'finished media')
        await writeFile(join(folder, `${outputId}.webp`), 'raw poster')
        await writeFile(join(folder, `${outputId}.info.json`), JSON.stringify({ id: 'vid1', extractor: 'youtube', title: 'A Video', uploader: 'Someone', duration: 12, original_url: 'https://example.test/watch' }))
        return { mediaPath: join(folder, `${outputId}.mp4`), infoJsonPath: join(folder, `${outputId}.info.json`) }
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
      download: async ({ dir: folder, outputId }) => {
        attempted = true
        await clearStem(folder, outputId)
        throw new Error('the source is gone')
      },
      committed: true,
      now: LATER,
    })).run()

    expect(attempted).toBe(false)
    expect((await readdir(join(dir, 'inbox', id))).sort()).toEqual([`${id}.jpg`, `${id}.json`, `${id}.mp4`])
    expect(await readFile(join(dir, 'inbox', id, `${id}.mp4`), 'utf8')).toBe('finished media')
    expect(relaunched.get(id)).toMatchObject({
      state: 'downloaded', filename: `${id}.mp4`, sidecarFilename: `${id}.json`, thumbnailFilename: `${id}.jpg`,
      sourceId: 'vid1', extractor: 'youtube', title: 'A Video', durationSeconds: 12,
      addedIndex: 3, addedAtUtc: ADDED, failureCode: null,
    })
  })
})

describe('findFinishedBundle', () => {
  const sidecar = (fields: Record<string, unknown> = {}) => JSON.stringify({
    formatVersion: 1, id: 'vid1', original_url: 'https://example.test/watch', tapebox: { media: null }, ...fields,
  })
  const folder = async (id: string, files: Record<string, string>) => {
    await mkdir(join(dir, id))
    for (const [name, text] of Object.entries(files)) await writeFile(join(dir, id, name), text)
    return join(dir, id)
  }

  it('finds nothing without a sidecar under the tape\'s stem, or without a folder', async () => {
    expect(await findFinishedBundle(await folder('Nosidecar1', { 'Nosidecar1.mp4.part': 'partial' }), queued('Nosidecar1'))).toEqual({ status: 'none' })
    expect(await findFinishedBundle(join(dir, 'Nofolder01'), queued('Nofolder01'))).toEqual({ status: 'none' })
  })

  it('finds nothing to protect when no media is on disk beside the sidecar', async () => {
    const at = await folder('Nomedia001', { 'Nomedia001.json': sidecar(), 'Nomedia001.mp4.part': 'partial', 'Nomedia001.webp': 'raw' })
    expect(await findFinishedBundle(at, queued('Nomedia001'))).toEqual({ status: 'none' })
  })

  it('reports a sidecar it cannot adopt, leaving it in place', async () => {
    const text = JSON.stringify({ formatVersion: 99, tapebox: {} })
    const at = await folder('Newer00001', { 'Newer00001.json': text, 'Newer00001.mp4': 'media' })
    expect(await findFinishedBundle(at, queued('Newer00001'))).toMatchObject({ status: 'unusable' })
    expect(await readFile(join(at, 'Newer00001.json'), 'utf8')).toBe(text)
  })

  it('refuses a folder where more than one file could be the media', async () => {
    const at = await folder('Twomedia01', { 'Twomedia01.json': sidecar(), 'Twomedia01.mp4': 'media', 'Twomedia01.mkv': 'media' })
    expect(await findFinishedBundle(at, queued('Twomedia01'))).toMatchObject({ status: 'unusable' })
  })

  it('takes the media, the poster when present, and the sidecar\'s time as the download time', async () => {
    const at = await folder('Found00001', { 'Found00001.json': sidecar(), 'Found00001.mp4': 'media', 'Found00001.f137.mp4': 'unmerged' })
    await utimes(join(at, 'Found00001.json'), new Date(FINISHED), new Date(FINISHED))
    expect(await findFinishedBundle(at, queued('Found00001'))).toMatchObject({
      status: 'found', move: { filename: 'Found00001.mp4', sidecarFilename: 'Found00001.json', thumbnailFilename: null, downloadedAtUtc: FINISHED },
    })
    await writeFile(join(at, 'Found00001.jpg'), 'poster')
    expect(await findFinishedBundle(at, queued('Found00001'))).toMatchObject({ status: 'found', move: { thumbnailFilename: 'Found00001.jpg' } })
  })

  it('refuses a finished sidecar from a different source', async () => {
    const id = 'Foreign001'
    const at = await folder(id, { [`${id}.json`]: sidecar({ original_url: 'https://example.test/another' }), [`${id}.mp4`]: 'foreign media' })
    expect(await findFinishedBundle(at, queued(id))).toMatchObject({ status: 'unusable' })
    expect(await readFile(join(at, `${id}.mp4`), 'utf8')).toBe('foreign media')
  })

  it('uses canonical source URL identity when recovering a finished sidecar', async () => {
    const id = 'Canonical1'
    const tape = { ...queued(id), sourceUrl: 'https://www.youtube.com/watch?v=sourceA' }
    const at = await folder(id, { [`${id}.json`]: sidecar({ original_url: `${tape.sourceUrl}&si=share` }), [`${id}.mp4`]: 'own media' })
    expect(await findFinishedBundle(at, tape)).toMatchObject({ status: 'found' })
  })

  it('uses a valid extractor and source ID pair when recovery URLs differ', async () => {
    const id = 'Sourcepair'
    const tape = { ...queued(id), sourceId: 'vid1', extractor: 'example' }
    const at = await folder(id, { [`${id}.json`]: sidecar({ original_url: 'https://example.test/canonical', extractor: 'Example' }), [`${id}.mp4`]: 'own media' })
    expect(await findFinishedBundle(at, tape)).toMatchObject({ status: 'found' })
  })

  it('does not use a bare provider ID as recovery source identity', async () => {
    const id = 'BareId0001'
    const tape = { ...queued(id), sourceId: 'vid1', extractor: 'example' }
    const at = await folder(id, { [`${id}.json`]: sidecar({ original_url: 'https://example.test/another' }), [`${id}.mp4`]: 'foreign media' })
    expect(await findFinishedBundle(at, tape)).toMatchObject({ status: 'unusable' })
  })
})
