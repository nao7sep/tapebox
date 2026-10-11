import { mkdir, mkdtemp, readFile, readdir, rm, symlink, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SessionSchema, type Tape } from '@shared/domain'
import type { ImportResult } from '@shared/ipc-contract'
import { unwrapIpcReply, type IpcReply } from '@shared/ipc-reply'

const state = vi.hoisted(() => ({
  libraryDir: '', catalog: '', heldCopy: '', holdCleanup: false, holdListing: false,
  started: () => {}, release: null as Promise<void> | null,
}))
const emit = vi.hoisted(() => vi.fn())
const thumbnail = vi.hoisted(() => ({ download: vi.fn(), save: vi.fn() }))
const handlers = new Map<string, (req: unknown) => Promise<unknown>>()
vi.mock('electron', () => ({
  ipcMain: { handle: (channel: string, fn: (event: unknown, req: unknown) => unknown) => {
    handlers.set(channel, async (req) => unwrapIpcReply(channel, await fn({}, req) as IpcReply<unknown>))
  } },
  shell: { showItemInFolder: vi.fn(), openPath: vi.fn(), trashItem: vi.fn() },
}))
vi.mock('@main/paths', () => ({ paths: { get catalog() { return state.catalog } } }))
vi.mock('@main/store/config', () => ({ getLibraryDir: () => state.libraryDir, getSettings: () => ({ trashOnRemove: false, externalPlayer: '' }) }))
vi.mock('@main/store/backupStore', () => ({ record: vi.fn() }))
vi.mock('@main/io/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }))
vi.mock('@main/ipc/events', () => ({ emit }))
vi.mock('@main/queue/manager', () => ({ isActive: () => false, cancel: vi.fn(), holdFromScheduling: () => () => {} }))
vi.mock('@main/services/ytdlp', () => ({ downloadThumbnail: thumbnail.download, probe: vi.fn(), download: vi.fn(), findThumbnail: vi.fn() }))
vi.mock('@main/services/ffmpeg', () => ({ saveThumbnailJpeg: thumbnail.save, probeMedia: vi.fn() }))
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return { ...actual, readdir: async (...args: Parameters<typeof actual.readdir>) => {
    const result = await actual.readdir(...args)
    if (state.holdListing && args[0] === state.libraryDir) {
      state.holdListing = false
      state.started()
      await state.release
    }
    return result
  } }
})
vi.mock('@main/io/atomic-file', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@main/io/atomic-file')>()
  return {
    ...actual,
    copyFileNoOverwrite: async (...args: Parameters<typeof actual.copyFileNoOverwrite>) => {
      await actual.copyFileNoOverwrite(...args)
      if (basename(args[1]) === state.heldCopy) {
        state.heldCopy = ''
        state.started()
        await state.release
      }
    },
    unlinkFiles: async (...args: Parameters<typeof actual.unlinkFiles>) => {
      if (state.holdCleanup && args[0].includes(join(state.libraryDir, 'Original.mp4'))) {
        state.holdCleanup = false
        state.started()
        await state.release
      }
      return actual.unlinkFiles(...args)
    },
  }
})

import { registerLibraryHandlers } from '@main/ipc/library'
import { registerExportHandlers } from '@main/ipc/export'
import { defaultJobDeps, Job } from '@main/queue/job'
import { findFinishedBundle } from '@main/queue/finished-bundle'
import * as session from '@main/store/session'

let root: string
let original: Tape
const AT = '2026-01-01T00:00:00.000Z'

function sidecar(sourceUrl: string, mediaFilename: string, thumbnailFilename: string | null = null): string {
  return JSON.stringify({ formatVersion: 1, tapebox: {
    sourceUrl, name: null, addedAtUtc: AT, downloadedAtUtc: AT, renamedAtUtc: null,
    media: null, mediaFilename, thumbnailFilename,
  } })
}

async function stage(stem: string, poster: string | null = null): Promise<string> {
  await writeFile(join(state.libraryDir, `${stem}.mp4`), `media:${stem}`)
  const path = join(state.libraryDir, `${stem}.json`)
  await writeFile(path, sidecar(`https://example.test/${stem}`, `${stem}.mp4`, poster))
  return path
}

async function importPath(path: string): Promise<ImportResult> {
  return await handlers.get('library:import')!({ paths: [path] }) as ImportResult
}

function hold(): { started: Promise<void>; release: () => void } {
  let started!: () => void
  let release!: () => void
  const ready = new Promise<void>((resolve) => { started = resolve })
  state.release = new Promise<void>((resolve) => { release = resolve })
  state.started = started
  return { started: ready, release }
}

async function assertCompleteCatalog(): Promise<Tape[]> {
  await session.persistNow()
  const saved = SessionSchema.parse(JSON.parse(await readFile(state.catalog, 'utf8'))).tapes
  expect(saved).toEqual(session.getTapes())
  const files = await readdir(state.libraryDir)
  for (const tape of saved) {
    for (const name of [tape.filename, tape.sidecarFilename, tape.thumbnailFilename]) {
      if (name) expect(files).toContain(name)
    }
  }
  return saved
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'tapebox-managed-files-'))
  state.libraryDir = join(root, 'library')
  state.catalog = join(root, 'catalog.json')
  state.heldCopy = ''
  state.holdCleanup = false
  state.holdListing = false
  state.release = null
  handlers.clear()
  emit.mockClear()
  thumbnail.download.mockReset()
  thumbnail.save.mockReset()
  await mkdir(state.libraryDir)
  await session.loadSession()
  original = {
    id: 'abc1234567', sourceUrl: 'https://example.test/clip', state: 'downloaded', addedAtUtc: AT,
    sourceId: null, extractor: null, title: 'Clip', uploader: null, durationSeconds: null, chapterCount: 0,
    probedAtUtc: null, filename: 'Original.mp4', sidecarFilename: 'Original.json', thumbnailFilename: null,
    downloadStartedAtUtc: null, downloadedAtUtc: AT, name: 'Original', renamedAtUtc: null,
    archivedAtUtc: null, boxId: null, order: 0, pausedAtUtc: null, failedAtUtc: null, failureCode: null, lastError: null,
  }
  await writeFile(join(state.libraryDir, 'Original.mp4'), 'video')
  await writeFile(join(state.libraryDir, 'Original.json'), sidecar(original.sourceUrl, 'Original.mp4'))
  session.upsertTape(original)
  await session.persistNow()
  registerLibraryHandlers()
  registerExportHandlers()
})

afterEach(async () => {
  await session.persistNow({ quitting: true })
  await rm(root, { recursive: true, force: true })
})

describe('managed filename ownership across producers and cleanup', () => {
  it('reports a catalog-owned rename target as a name conflict even when its physical file is missing', async () => {
    const owner: Tape = { ...original, id: 'other12345', sourceUrl: 'https://example.test/owner', filename: 'Renamed.mp4', sidecarFilename: 'Owner.json', name: null, order: -1 }
    await writeFile(join(state.libraryDir, 'Owner.json'), sidecar(owner.sourceUrl, 'Renamed.mp4'))
    session.upsertTape(owner)
    await session.persistNow()
    await expect(handlers.get('library:rename')!({ tapeId: original.id, name: 'Renamed' }))
      .rejects.toMatchObject({ code: 'conflict', userMessage: { key: 'rename.failed' } })
    expect(await readFile(join(state.libraryDir, 'Original.mp4'), 'utf8')).toBe('video')
    await expect(readFile(join(state.libraryDir, 'Renamed.mp4'))).rejects.toMatchObject({ code: 'ENOENT' })
    const saved = SessionSchema.parse(JSON.parse(await readFile(state.catalog, 'utf8'))).tapes
    expect(saved).toEqual([original, owner])
  })

  it('omits an obsolete rename poster until its physical cleanup settles', async () => {
    await writeFile(join(state.libraryDir, 'Original.jpg'), 'poster')
    session.upsertTape({ ...original, thumbnailFilename: 'Original.jpg' })
    await writeFile(join(state.libraryDir, 'Original.json'), sidecar(original.sourceUrl, 'Original.mp4', 'Original.jpg'))
    const otherPath = await stage('Other', 'Original.jpg')
    const gate = hold()
    state.holdCleanup = true
    const renaming = handlers.get('library:rename')!({ tapeId: original.id, name: 'Renamed' })
    let other!: ImportResult
    try {
      await gate.started
      expect(session.getTape(original.id)?.thumbnailFilename).toBe('Renamed.jpg')
      other = await importPath(otherPath)
    } finally { gate.release() }
    await renaming
    expect(other.imported).toHaveLength(1)
    expect(other.imported[0]?.thumbnailFilename).toBeNull()
    expect(other.issues.map((issue) => issue.reason.key)).toEqual(['import.thumbnailNameTaken'])
    expect(await readFile(join(state.libraryDir, 'Renamed.jpg'), 'utf8')).toBe('poster')
    await expect(readFile(join(state.libraryDir, 'Original.jpg'))).rejects.toMatchObject({ code: 'ENOENT' })
    await assertCompleteCatalog()
  })

  it.each(['same', 'dot', 'symlink'])('refuses import of an export destination in the managed folder through rollback (alias: %s)', async (alias) => {
    const bytes = sidecar('https://example.test/independent', 'Exported.mp4')
    const adoptPath = join(state.libraryDir, 'adopt.json')
    await writeFile(adoptPath, bytes)
    const unrelatedPath = await stage('Unrelated')
    const aliasPath = join(root, 'selected-alias')
    if (alias === 'symlink') await symlink(state.libraryDir, aliasPath, 'junction')
    const destinationDir = alias === 'symlink' ? aliasPath : alias === 'dot' ? `${state.libraryDir}/.` : state.libraryDir
    const gate = hold()
    state.heldCopy = 'Exported.mp4'
    const exporting = handlers.get('export:files')!({ tapeId: original.id, name: 'Exported', destinationDir, deleteFromApp: false })
      .then(() => null, (error: unknown) => error)
    let adoption!: ImportResult
    let unrelated!: ImportResult
    try {
      await gate.started
      adoption = await importPath(adoptPath)
      unrelated = await importPath(unrelatedPath)
      await writeFile(join(state.libraryDir, 'Exported.json'), bytes, { flag: 'wx' }).catch((error: unknown) => {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      })
    } finally { gate.release() }
    expect(await exporting).toBeInstanceOf(Error)
    expect(adoption.imported).toEqual([])
    expect(adoption.issues.map((issue) => issue.reason.key)).toEqual(['import.nameTaken'])
    expect(unrelated.imported).toHaveLength(1)
    expect(await readFile(join(state.libraryDir, 'Original.mp4'), 'utf8')).toBe('video')
    expect(await readFile(adoptPath, 'utf8')).toBe(bytes)
    await expect(readFile(join(state.libraryDir, 'Exported.mp4'))).rejects.toMatchObject({ code: 'ENOENT' })
    await assertCompleteCatalog()
  })

  it('keeps Apply raw and JPEG poster ownership through its catalog settlement while unrelated imports proceed', async () => {
    await writeFile(join(state.libraryDir, 'Original.jpg'), 'old poster')
    const otherPath = await stage('Other', 'Original.jpg')
    const gate = hold()
    thumbnail.download.mockImplementationOnce(async () => {
      const raw = join(state.libraryDir, `${original.id}.poster-raw.webp`)
      await writeFile(raw, 'raw poster')
      state.started()
      await state.release
      return raw
    })
    thumbnail.save.mockImplementationOnce(async (_id, raw) => {
      await writeFile(join(state.libraryDir, 'Original.jpg'), 'replacement poster')
      await unlink(raw)
      return 'Original.jpg'
    })
    const applying = handlers.get('library:applyMetadata')!({ tapeId: original.id, metadata: {
      title: 'New title', uploader: null, description: 'New description', probedAtUtc: AT,
    } }).then((result) => result, (error: unknown) => error)
    let other!: ImportResult
    try { await gate.started; other = await importPath(otherPath) } finally { gate.release() }
    const applied = await applying
    expect(applied).not.toBeInstanceOf(Error)
    expect(other.imported).toHaveLength(1)
    expect(other.imported[0]?.thumbnailFilename).toBeNull()
    expect(other.issues.map((issue) => issue.reason.key)).toEqual(['import.thumbnailNameTaken'])
    expect(session.getTape(original.id)?.thumbnailFilename).toBe('Original.jpg')
    expect(await readFile(join(state.libraryDir, 'Original.jpg'), 'utf8')).toBe('replacement poster')
    await assertCompleteCatalog()
  })

  it.each(['conversion-failure', 'stale-input'])('removes only Apply scratch after the raw provider settles (%s)', async (outcome) => {
    const scratch = join(state.libraryDir, `${original.id}.poster-raw.webp`)
    await writeFile(join(state.libraryDir, 'Original.jpg'), 'existing literal poster')
    const gate = hold()
    thumbnail.download.mockImplementationOnce(async () => {
      await writeFile(scratch, 'raw poster')
      state.started()
      await state.release
      return scratch
    })
    thumbnail.save.mockRejectedValueOnce(new Error('conversion failed'))
    const applying = handlers.get('library:applyMetadata')!({ tapeId: original.id, metadata: {
      title: 'New title', uploader: null, description: 'New description', probedAtUtc: AT,
    } }).then((result) => result, (error: unknown) => error)
    try {
      await gate.started
      if (outcome === 'stale-input') session.upsertTape({ ...session.getTape(original.id)!, title: 'Newer title' })
      expect(await readFile(scratch, 'utf8')).toBe('raw poster')
    } finally { gate.release() }
    const result = await applying
    expect(result instanceof Error).toBe(outcome === 'stale-input')
    if (outcome === 'stale-input') expect(thumbnail.save).not.toHaveBeenCalled()
    await expect(readFile(scratch)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await readFile(join(state.libraryDir, 'Original.jpg'), 'utf8')).toBe('existing literal poster')
    expect(session.getTape(original.id)?.thumbnailFilename).toBeNull()
    await assertCompleteCatalog()
  })

  it('releases a completed managed export so its independent output can be imported later', async () => {
    await handlers.get('export:files')!({ tapeId: original.id, name: 'Exported', destinationDir: state.libraryDir, deleteFromApp: false })
    await handlers.get('library:remove')!({ tapeIds: [original.id], deleteFiles: false })
    const imported = await importPath(join(state.libraryDir, 'Exported.json'))
    expect(imported.imported).toHaveLength(1)
    expect(imported.issues).toEqual([])
    expect(await readFile(join(state.libraryDir, 'Original.mp4'), 'utf8')).toBe('video')
    await assertCompleteCatalog()
  })

  it('reserves a queued tape ID before filenames exist and refuses foreign-source recovery without clearing files', async () => {
    const queued: Tape = { ...original, state: 'queued', filename: null, sidecarFilename: null, thumbnailFilename: null, downloadedAtUtc: null }
    session.upsertTape(queued)
    const bundlePath = await stage(original.id)
    const imported = await importPath(bundlePath)
    const download = vi.fn(async () => { throw new Error('foreign files must not be cleared') })
    await new Job(queued, { ...defaultJobDeps, ytdlp: { ...defaultJobDeps.ytdlp, download } }).run()
    expect(imported.imported).toEqual([])
    expect(imported.issues.map((issue) => issue.reason.key)).toEqual(['import.nameTaken'])
    expect(download).not.toHaveBeenCalled()
    expect(session.getTape(original.id)).toMatchObject({ state: 'failed', filename: null, sidecarFilename: null })
    expect(await readFile(join(state.libraryDir, `${original.id}.mp4`), 'utf8')).toBe(`media:${original.id}`)
    await assertCompleteCatalog()
  })

  it('keeps legacy other-row ownership in a queued ID namespace and refuses adoption or download cleanup', async () => {
    const queued: Tape = { ...original, state: 'queued', filename: null, sidecarFilename: null, thumbnailFilename: null, downloadedAtUtc: null }
    session.upsertTape(queued)
    await writeFile(join(state.libraryDir, `${original.id}.mp4`), 'owned by another row')
    await writeFile(join(state.libraryDir, `${original.id}.json`), sidecar(original.sourceUrl, `${original.id}.mp4`))
    const owner: Tape = { ...original, id: 'other12345', sourceUrl: 'https://example.test/owner', filename: `${original.id}.mp4`, sidecarFilename: `${original.id}.json`, name: null, order: -1 }
    session.upsertTape(owner)
    await session.persistNow()
    const download = vi.fn(async () => { throw new Error('owned files must not be cleared') })
    await new Job(queued, { ...defaultJobDeps, ytdlp: { ...defaultJobDeps.ytdlp, download } }).run()
    expect(download).not.toHaveBeenCalled()
    expect(session.getTape(original.id)).toMatchObject({ state: 'failed', filename: null })
    expect(await readFile(join(state.libraryDir, `${original.id}.mp4`), 'utf8')).toBe('owned by another row')
    await assertCompleteCatalog()
  })

  it('allows an unrelated import while a download owns its ID namespace through postprocessing and commit', async () => {
    const queued: Tape = { ...original, state: 'queued', filename: null, sidecarFilename: null, thumbnailFilename: null, downloadedAtUtc: null }
    session.upsertTape(queued)
    const adoptPath = join(state.libraryDir, 'adopt.json')
    await writeFile(adoptPath, sidecar('https://example.test/foreign', `${original.id}.mp4`))
    const unrelatedPath = await stage('Unrelated')
    const gate = hold()
    const downloading = new Job(queued, {
      ...defaultJobDeps,
      ytdlp: {
        ...defaultJobDeps.ytdlp,
        probe: async () => ({ kind: 'video', id: 'sourceA', extractor: 'Example', title: 'Video', uploader: null, description: null, duration: null, chapters: null }),
        download: async ({ outputId, libraryDir }) => {
          const mediaPath = join(libraryDir, `${outputId}.mp4`)
          const infoJsonPath = join(libraryDir, `${outputId}.info.json`)
          await writeFile(mediaPath, 'own media')
          await writeFile(infoJsonPath, JSON.stringify({ id: 'sourceA', extractor: 'Example', title: 'Video' }))
          state.started()
          await state.release
          return { mediaPath, infoJsonPath }
        },
        findThumbnail: async () => null,
      },
      ffmpeg: { ...defaultJobDeps.ffmpeg, probeMedia: async () => ({ width: null, height: null, fps: null, vcodec: null, acodec: null, durationSeconds: null, bitrateKbps: null }) },
    }).run()
    let refused!: ImportResult
    let unrelated!: ImportResult
    try {
      await gate.started
      refused = await importPath(adoptPath)
      unrelated = await importPath(unrelatedPath)
    } finally { gate.release() }
    await downloading
    expect(refused.imported).toEqual([])
    expect(refused.issues.map((issue) => issue.reason.key)).toEqual(['import.nameTaken'])
    expect(unrelated.imported).toHaveLength(1)
    expect(session.getTape(original.id)).toMatchObject({ state: 'downloaded', filename: `${original.id}.mp4`, sidecarFilename: `${original.id}.json` })
    await assertCompleteCatalog()
  })

  it('rechecks current ownership after the finished-bundle read waits before adopting', async () => {
    const queued: Tape = { ...original, state: 'queued', filename: null, sidecarFilename: null, thumbnailFilename: null, downloadedAtUtc: null }
    session.upsertTape(queued)
    await writeFile(join(state.libraryDir, `${original.id}.mp4`), 'legacy media')
    await writeFile(join(state.libraryDir, `${original.id}.json`), sidecar(queued.sourceUrl, `${original.id}.mp4`))
    await writeFile(join(state.libraryDir, 'Owner.json'), sidecar('https://example.test/owner', `${original.id}.mp4`))
    const gate = hold()
    const download = vi.fn(async () => { throw new Error('owned files must not be cleared') })
    const recovering = new Job(queued, { ...defaultJobDeps,
      ytdlp: { ...defaultJobDeps.ytdlp, download },
      findFinishedBundle: async (...args) => {
        const result = await findFinishedBundle(...args)
        state.started()
        await state.release
        return result
      },
    }).run()
    try {
      await gate.started
      // Establish a current legacy owner at the authoritative session boundary
      // while the filesystem result still names a previously unowned file.
      session.upsertTape({ ...original, id: 'other12345', sourceUrl: 'https://example.test/owner', filename: `${original.id}.mp4`, sidecarFilename: 'Owner.json', name: null, order: -1 })
    } finally { gate.release() }
    await recovering
    expect(download).not.toHaveBeenCalled()
    expect(session.getTape(original.id)).toMatchObject({ state: 'failed', filename: null })
    expect(await readFile(join(state.libraryDir, `${original.id}.mp4`), 'utf8')).toBe('legacy media')
    await assertCompleteCatalog()
  })

  it('refuses recovery of a legacy poster outside its ID stem while another producer owns it', async () => {
    const queued: Tape = { ...original, state: 'queued', filename: null, sidecarFilename: null, thumbnailFilename: null, downloadedAtUtc: null }
    session.upsertTape(queued)
    await writeFile(join(state.libraryDir, `${original.id}.mp4`), 'own finished media')
    await writeFile(join(state.libraryDir, `${original.id}.json`), sidecar(queued.sourceUrl, `${original.id}.mp4`, 'PosterOwner.jpg'))
    await writeFile(join(state.libraryDir, 'PosterOwner.jpg'), 'untracked legacy poster')
    await stage('PosterOwner')
    const posterOwner: Tape = { ...original, id: 'posterownr', sourceUrl: 'https://example.test/PosterOwner', filename: 'PosterOwner.mp4', sidecarFilename: 'PosterOwner.json', name: null, order: -1 }
    session.upsertTape(posterOwner)
    const gate = hold()
    thumbnail.download.mockImplementationOnce(async () => {
      const raw = join(state.libraryDir, `${posterOwner.id}.poster-raw.webp`)
      await writeFile(raw, 'raw poster')
      state.started()
      await state.release
      return raw
    })
    thumbnail.save.mockImplementationOnce(async () => {
      await writeFile(join(state.libraryDir, 'PosterOwner.jpg'), 'new poster')
      return 'PosterOwner.jpg'
    })
    const applying = handlers.get('library:applyMetadata')!({ tapeId: posterOwner.id, metadata: {
      title: 'New title', uploader: null, description: 'New description', probedAtUtc: AT,
    } })
    const download = vi.fn(async () => { throw new Error('recovery must not clear a producer-owned poster') })
    try {
      await gate.started
      await new Job(queued, { ...defaultJobDeps, ytdlp: { ...defaultJobDeps.ytdlp, download } }).run()
      expect(session.getTape(original.id)).toMatchObject({ state: 'failed', filename: null, thumbnailFilename: null })
      expect(download).not.toHaveBeenCalled()
    } finally { gate.release() }
    await applying
    expect(session.getTape(posterOwner.id)?.thumbnailFilename).toBe('PosterOwner.jpg')
    expect(await readFile(join(state.libraryDir, 'PosterOwner.jpg'), 'utf8')).toBe('new poster')
    await assertCompleteCatalog()
  })

  it('omits a removal stem leftover while its directory listing and physical discard are pending', async () => {
    const poster = `${original.id}.jpg`
    await writeFile(join(state.libraryDir, poster), 'leftover poster')
    const otherPath = await stage('Other', poster)
    const gate = hold()
    state.holdListing = true
    const removing = handlers.get('library:remove')!({ tapeIds: [original.id], deleteFiles: true })
    let other!: ImportResult
    try { await gate.started; other = await importPath(otherPath) } finally { gate.release() }
    await removing
    expect(other.imported).toHaveLength(1)
    expect(other.imported[0]?.thumbnailFilename).toBeNull()
    expect(other.issues.map((issue) => issue.reason.key)).toEqual(['import.thumbnailNameTaken'])
    expect(session.getTape(original.id)).toBeUndefined()
    await expect(readFile(join(state.libraryDir, poster))).rejects.toMatchObject({ code: 'ENOENT' })
    await assertCompleteCatalog()
  })

  it('preserves a stem leftover already tracked by a legacy independent row on removal', async () => {
    const poster = `${original.id}.jpg`
    await writeFile(join(state.libraryDir, poster), 'legacy poster')
    await stage('Other', poster)
    const owner: Tape = { ...original, id: 'other12345', sourceUrl: 'https://example.test/Other', filename: 'Other.mp4', sidecarFilename: 'Other.json', thumbnailFilename: poster, name: null, order: -1 }
    session.upsertTape(owner)
    await handlers.get('library:remove')!({ tapeIds: [original.id], deleteFiles: true })
    expect(session.getTapes()).toEqual([owner])
    expect(await readFile(join(state.libraryDir, poster), 'utf8')).toBe('legacy poster')
    await assertCompleteCatalog()
  })

  it('rereads current legacy ownership after a removal directory listing waits', async () => {
    const poster = `${original.id}.jpg`
    await writeFile(join(state.libraryDir, poster), 'legacy poster')
    await stage('Other', poster)
    const owner: Tape = { ...original, id: 'other12345', sourceUrl: 'https://example.test/Other', filename: 'Other.mp4', sidecarFilename: 'Other.json', thumbnailFilename: poster, name: null, order: -1 }
    const gate = hold()
    state.holdListing = true
    const removing = handlers.get('library:remove')!({ tapeIds: [original.id], deleteFiles: true })
    try { await gate.started; session.upsertTape(owner) } finally { gate.release() }
    await removing
    expect(session.getTapes()).toEqual([owner])
    expect(await readFile(join(state.libraryDir, poster), 'utf8')).toBe('legacy poster')
    await assertCompleteCatalog()
  })
})
