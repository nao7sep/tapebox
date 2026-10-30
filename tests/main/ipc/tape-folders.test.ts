vi.mock('@main/ipc/trust', () => ({ isTrustedApplicationSender: () => true }))
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { type Tape } from '@shared/domain'
import type { ImportResult } from '@shared/ipc-contract'
import { unwrapIpcReply, type IpcReply } from '@shared/ipc-reply'

// Each tape's files live in its own folder, so producers, cleanup and imports
// meet only in the folders they own. The collection owner, the library handlers,
// export and the download job are the real ones; providers are substituted.
const state = vi.hoisted(() => ({
  libraryDir: '', events: [] as string[],
  started: () => {}, release: null as Promise<void> | null,
}))
const emit = vi.hoisted(() => vi.fn())
const thumbnail = vi.hoisted(() => ({ download: vi.fn(), save: vi.fn() }))
const queue = vi.hoisted(() => ({ isActive: vi.fn(() => false), cancel: vi.fn(async (_id: string) => {}) }))
const handlers = new Map<string, (req: unknown) => Promise<unknown>>()
vi.mock('electron', () => ({
  ipcMain: { handle: (channel: string, fn: (event: unknown, req: unknown) => unknown) => {
    handlers.set(channel, async (req) => unwrapIpcReply(channel, await fn({}, req) as IpcReply<unknown>))
  } },
  shell: { showItemInFolder: vi.fn(), openPath: vi.fn(), trashItem: vi.fn() },
}))
vi.mock('@main/store/config', () => ({ getCollectionDir: () => state.libraryDir, getSettings: () => ({ trashOnRemove: false, externalPlayer: '' }) }))
vi.mock('@main/store/backupStore', () => ({ record: vi.fn() }))
vi.mock('@main/io/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }))
vi.mock('@main/ipc/events', () => ({ emit }))
vi.mock('@main/queue/manager', () => ({ ...queue, holdFromScheduling: () => () => {} }))
vi.mock('@main/services/ytdlp', () => ({ downloadThumbnail: thumbnail.download, probe: vi.fn(), download: vi.fn(), findThumbnail: vi.fn() }))
vi.mock('@main/services/ffmpeg', () => ({ saveThumbnailJpeg: thumbnail.save, probeMedia: vi.fn() }))
import { registerCollectionHandlers } from '@main/ipc/collection'
import { registerExportHandlers } from '@main/ipc/export'
import { defaultJobDeps, Job } from '@main/queue/job'
import * as session from '@main/store/session'
import { tapeDir } from '@main/paths'

let root: string
let original: Tape
const AT = '2026-01-01T00:00:00.000Z'

function sidecar(sourceUrl: string, mediaFilename: string, thumbnailFilename: string | null = null): string {
  return JSON.stringify({ formatVersion: 1, id: sourceUrl, tapebox: {
    sourceUrl, name: null, addedAtUtc: AT, downloadedAtUtc: AT, renamedAtUtc: null,
    media: null, mediaFilename, thumbnailFilename,
  } })
}

/** An exported bundle outside the library, as import reads it. */
async function stage(folder: string, stem: string, sourceUrl = `https://example.test/${folder}/${stem}`): Promise<string> {
  const dir = join(root, folder)
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, `${stem}.mp4`), `media:${folder}`)
  const path = join(dir, `${stem}.json`)
  await writeFile(path, sidecar(sourceUrl, `${stem}.mp4`))
  return path
}

async function importPath(path: string): Promise<ImportResult> {
  return await handlers.get('collection:import')!({ paths: [path] }) as ImportResult
}

function hold(): { started: Promise<void>; release: () => void } {
  let started!: () => void
  let release!: () => void
  const ready = new Promise<void>((resolve) => { started = resolve })
  state.release = new Promise<void>((resolve) => { release = resolve })
  state.started = started
  return { started: ready, release }
}

/** An Inbox tape's own folder in the collection. */
function inboxFolder(id: string): string {
  return tapeDir(state.libraryDir, { id, shelved: false })
}

/** The saved collection matches the live one, and every name it gives is in its tape's folder. */
async function assertCompleteCatalog(): Promise<Tape[]> {
  await session.persistNow()
  const read = await session.readCollection(state.libraryDir)
  if (read.kind !== 'current') throw new Error('expected the current layout')
  const byId = (a: Tape, b: Tape) => a.id.localeCompare(b.id)
  const saved = [...read.session.tapes].sort(byId)
  expect(saved).toEqual(session.getTapes().map(session.durableTape).sort(byId))
  for (const tape of saved) {
    for (const name of [tape.filename, tape.sidecarFilename, tape.thumbnailFilename]) {
      if (name) expect(await readdir(tapeDir(state.libraryDir, tape))).toContain(name)
    }
  }
  return saved
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'tapebox-tape-folders-'))
  state.libraryDir = join(root, 'library')
  state.release = null
  state.events = []
  queue.isActive.mockReset().mockReturnValue(false)
  queue.cancel.mockReset().mockResolvedValue(undefined)
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
    addedIndex: 0, shelved: false, boxId: null, order: 0, pausedAtUtc: null, failedAtUtc: null, failureCode: null, lastError: null,
  }
  await mkdir(inboxFolder(original.id), { recursive: true })
  await writeFile(join(inboxFolder(original.id), 'Original.mp4'), 'video')
  await writeFile(join(inboxFolder(original.id), 'Original.json'), JSON.stringify({ formatVersion: 1, tapebox: { media: null } }))
  session.upsertTape(original)
  await session.persistNow()
  registerCollectionHandlers()
  registerExportHandlers()
})

afterEach(async () => {
  await session.persistNow({ quitting: true })
  await rm(root, { recursive: true, force: true })
})

describe('tape folders across producers and cleanup', () => {
  it('removes each tape\'s folder, late fragments included, after every selected producer settles', async () => {
    const other: Tape = { ...original, id: 'other12345', sourceUrl: 'https://example.test/other' }
    await mkdir(inboxFolder(other.id), { recursive: true })
    await writeFile(join(inboxFolder(other.id), 'Original.mp4'), 'other video')
    session.upsertTape(other)
    const gate = hold()
    queue.isActive.mockReturnValue(true)
    queue.cancel.mockImplementation(async (id) => {
      if (id === other.id) { state.started(); await state.release }
      // A producer may leave a last fragment while its cancellation settles.
      await writeFile(join(inboxFolder(id), `${id}.mp4.part`), 'late fragment')
      state.events.push(`settled:${id}`)
    })
    const removing = handlers.get('collection:remove')!({ tapeIds: [original.id, other.id], deleteFiles: true })
    try {
      await gate.started
      expect(await readFile(join(inboxFolder(original.id), 'Original.mp4'), 'utf8')).toBe('video')
      expect(await readFile(join(inboxFolder(other.id), 'Original.mp4'), 'utf8')).toBe('other video')
    } finally { gate.release() }
    await removing
    expect(queue.cancel.mock.calls).toEqual([[original.id], [other.id]])
    expect(state.events).toEqual([`settled:${original.id}`, `settled:${other.id}`])
    expect(session.getTapes()).toEqual([])
    expect(await readdir(join(state.libraryDir, 'inbox'))).toEqual([])
  })

  it('removes a tape whose folder is already gone', async () => {
    await rm(inboxFolder(original.id), { recursive: true })
    await handlers.get('collection:remove')!({ tapeIds: [original.id], deleteFiles: true })
    expect(session.getTapes()).toEqual([])
  })

  it('imports bundles whose files share names, each into a folder of its own, keeping no catalog copies in the sidecar', async () => {
    const first = await stage('first', 'Original')
    const second = await stage('second', 'Original')
    const result = await handlers.get('collection:import')!({ paths: [first, second] }) as ImportResult
    expect(result.issues).toEqual([])
    expect(result.imported.map((tape) => tape.filename)).toEqual(['Original.mp4', 'Original.mp4'])
    const [a, b] = result.imported
    expect(new Set([original.id, a!.id, b!.id]).size).toBe(3)
    expect(await readFile(join(inboxFolder(a!.id), 'Original.mp4'), 'utf8')).toBe('media:first')
    expect(await readFile(join(inboxFolder(b!.id), 'Original.mp4'), 'utf8')).toBe('media:second')
    const kept = JSON.parse(await readFile(join(inboxFolder(a!.id), 'Original.json'), 'utf8'))
    expect(kept.tapebox).toEqual({ media: null })
    expect(kept.id).toBe('https://example.test/first/Original')
    expect(await readFile(join(inboxFolder(original.id), 'Original.mp4'), 'utf8')).toBe('video')
    await assertCompleteCatalog()
  })

  it('removes only Apply scratch after the raw provider settles and conversion fails', async () => {
    const folder = inboxFolder(original.id)
    const scratch = join(folder, `${original.id}.poster-raw.webp`)
    await writeFile(join(folder, 'Original.jpg'), 'existing literal poster')
    const gate = hold()
    thumbnail.download.mockImplementationOnce(async (_id: string, _url: string, dir: string) => {
      expect(dir).toBe(folder)
      await writeFile(scratch, 'raw poster')
      state.started()
      await state.release
      return scratch
    })
    thumbnail.save.mockRejectedValueOnce(new Error('conversion failed'))
    const applying = handlers.get('collection:applyMetadata')!({ tapeId: original.id, metadata: {
      title: 'New title', uploader: null, description: 'New description', probedAtUtc: AT,
    } }).then((result) => result, (error: unknown) => error)
    try {
      await gate.started
      expect(await readFile(scratch, 'utf8')).toBe('raw poster')
    } finally { gate.release() }
    const result = await applying
    expect(result).not.toBeInstanceOf(Error)
    await expect(readFile(scratch)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await readFile(join(folder, 'Original.jpg'), 'utf8')).toBe('existing literal poster')
    expect(session.getTape(original.id)?.thumbnailFilename).toBeNull()
    await assertCompleteCatalog()
  })

  it('exports into the library folder itself, and that output imports back after the tape is removed', async () => {
    await handlers.get('export:files')!({ tapeId: original.id, name: 'Exported', destinationDir: state.libraryDir, deleteFromApp: false })
    await handlers.get('collection:remove')!({ tapeIds: [original.id], deleteFiles: false })
    const imported = await importPath(join(state.libraryDir, 'Exported.json'))
    expect(imported.issues).toEqual([])
    expect(imported.imported).toMatchObject([{ filename: 'Exported.mp4', sidecarFilename: 'Exported.json', name: 'Exported' }])
    expect(await readFile(join(inboxFolder(original.id), 'Original.mp4'), 'utf8')).toBe('video')
    await assertCompleteCatalog()
  })

  it('allows an import while a download writes into its own folder through postprocessing and commit', async () => {
    const queued: Tape = { ...original, state: 'queued', filename: null, sidecarFilename: null, thumbnailFilename: null, downloadedAtUtc: null }
    await rm(inboxFolder(original.id), { recursive: true })
    session.upsertTape(queued)
    const unrelatedPath = await stage('unrelated', `${original.id}`)
    const gate = hold()
    const downloading = new Job(queued, {
      ...defaultJobDeps,
      ytdlp: {
        ...defaultJobDeps.ytdlp,
        probe: async () => ({ kind: 'video', id: 'sourceA', extractor: 'Example', title: 'Video', uploader: null, description: null, duration: null, chapters: null }),
        download: async ({ outputId, dir }) => {
          const mediaPath = join(dir, `${outputId}.mp4`)
          const infoJsonPath = join(dir, `${outputId}.info.json`)
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
    let unrelated!: ImportResult
    try {
      await gate.started
      unrelated = await importPath(unrelatedPath)
    } finally { gate.release() }
    await downloading
    expect(unrelated.issues).toEqual([])
    expect(unrelated.imported).toMatchObject([{ filename: `${original.id}.mp4` }])
    expect(session.getTape(original.id)).toMatchObject({ state: 'downloaded', filename: `${original.id}.mp4`, sidecarFilename: `${original.id}.json` })
    expect(await readFile(join(inboxFolder(original.id), `${original.id}.mp4`), 'utf8')).toBe('own media')
    await assertCompleteCatalog()
  })
})
