vi.mock('@main/ipc/trust', () => ({ isTrustedApplicationSender: () => true }))
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SessionSchema, type Tape } from '@shared/domain'
import type { ImportResult } from '@shared/ipc-contract'
import { unwrapIpcReply, type IpcReply } from '@shared/ipc-reply'

const state = vi.hoisted(() => ({
  libraryDir: '', catalog: '', holdRename: false, holdCleanup: false, holdMediaPublication: false,
  started: () => {}, release: null as Promise<void> | null,
}))
const emit = vi.hoisted(() => vi.fn())
const handlers = new Map<string, (req: unknown) => Promise<unknown>>()
vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, fn: (event: unknown, req: unknown) => unknown) => {
      handlers.set(channel, async (req) => unwrapIpcReply(channel, await fn({}, req) as IpcReply<unknown>))
    },
  },
  shell: { showItemInFolder: vi.fn(), openPath: vi.fn(), trashItem: vi.fn() },
}))
vi.mock('@main/paths', () => ({ paths: { get legacyCatalog() { return state.catalog + '.legacy' } }, collectionCatalog: () => state.catalog }))
vi.mock('@main/store/config', () => ({
  getLibraryDir: () => state.libraryDir,
  getSettings: () => ({ trashOnRemove: false, externalPlayer: '' }),
}))
vi.mock('@main/store/backupStore', () => ({ record: vi.fn() }))
vi.mock('@main/io/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }))
vi.mock('@main/ipc/events', () => ({ emit }))
vi.mock('@main/queue/manager', () => ({ isActive: vi.fn(() => false), cancel: vi.fn() }))
vi.mock('@main/services/ytdlp', () => ({ downloadThumbnail: vi.fn(), probe: vi.fn() }))
vi.mock('@main/services/ffmpeg', () => ({ saveThumbnailJpeg: vi.fn() }))
vi.mock('@main/io/atomic-json', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@main/io/atomic-json')>()
  return {
    ...actual,
    writeManagedJsonBytes: async (...args: Parameters<typeof actual.writeManagedJsonBytes>) => {
      const candidate = JSON.parse(args[1].toString('utf8')) as { tapes: Tape[] }
      if (state.holdRename && candidate.tapes.some((tape) => tape.name === 'Renamed')) {
        state.holdRename = false
        state.started()
        await state.release
      }
      return actual.writeManagedJsonBytes(...args)
    },
  }
})
vi.mock('@main/io/atomic-file', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@main/io/atomic-file')>()
  return {
    ...actual,
    linkOrCopyNoOverwrite: async (...args: Parameters<typeof actual.linkOrCopyNoOverwrite>) => {
      const result = await actual.linkOrCopyNoOverwrite(...args)
      if (state.holdMediaPublication && args[1] === join(state.libraryDir, 'Renamed.mp4')) {
        state.holdMediaPublication = false
        state.started()
        await state.release
      }
      return result
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
import * as session from '@main/store/session'

let root: string
let original: Tape

beforeEach(async () => {
  handlers.clear()
  emit.mockClear()
  root = await mkdtemp(join(tmpdir(), 'tapebox-rename-concurrency-'))
  state.libraryDir = join(root, 'library')
  state.catalog = join(root, 'catalog.json')
  state.holdRename = false
  state.holdCleanup = false
  state.holdMediaPublication = false
  state.release = null
  await mkdir(state.libraryDir)
  await session.loadSession()
  original = {
    id: 'abc1234567', sourceUrl: 'https://example.test/clip', state: 'downloaded',
    addedAtUtc: '2026-01-01T00:00:00.000Z', sourceId: null, extractor: null,
    title: 'Clip', uploader: null, durationSeconds: null, chapterCount: null,
    probedAtUtc: null, filename: 'Original.mp4', sidecarFilename: 'Original.json',
    thumbnailFilename: null, downloadStartedAtUtc: null, downloadedAtUtc: '2026-01-01T00:00:00.000Z',
    name: 'Original', renamedAtUtc: null, archivedAtUtc: null, boxId: null, order: 0,
    pausedAtUtc: null, failedAtUtc: null, failureCode: null, lastError: null,
  }
  await writeFile(join(state.libraryDir, original.filename!), 'video')
  await writeFile(join(state.libraryDir, original.sidecarFilename!), JSON.stringify({
    formatVersion: 1,
    tapebox: {
      sourceUrl: original.sourceUrl, name: original.name, addedAtUtc: original.addedAtUtc,
      downloadedAtUtc: original.downloadedAtUtc, renamedAtUtc: null, media: null,
      mediaFilename: original.filename, thumbnailFilename: null,
    },
  }))
  session.upsertTape(original)
  await session.persistNow()
  registerLibraryHandlers()
})

afterEach(async () => {
  await session.persistNow({ quitting: true })
  await rm(root, { recursive: true, force: true })
})

describe('rename publication across the real session commit', () => {
  it('refuses adoption of rollback-only rename media, retains the original bundle, and releases the filename afterward', async () => {
    // This valid independent sidecar predates the rename. Its media does not
    // exist until the rename publishes a destination that it may still remove.
    const independentSidecar = JSON.stringify({
      formatVersion: 1,
      tapebox: {
        sourceUrl: 'https://example.test/independent', name: 'Independent', addedAtUtc: original.addedAtUtc,
        downloadedAtUtc: original.downloadedAtUtc, renamedAtUtc: null, media: null,
        mediaFilename: 'Renamed.mp4', thumbnailFilename: null,
      },
    })
    const adoptPath = join(state.libraryDir, 'adopt.json')
    await writeFile(adoptPath, independentSidecar)
    const originalSidecar = await readFile(join(state.libraryDir, 'Original.json'), 'utf8')
    let started!: () => void
    let release!: () => void
    const held = new Promise<void>((resolve) => { started = resolve })
    state.release = new Promise<void>((resolve) => { release = resolve })
    state.started = started
    state.holdMediaPublication = true
    const renaming = handlers.get('library:rename')!({ tapeId: original.id, name: 'Renamed' })
      .then(() => null, (error: unknown) => error)
    let adoption!: ImportResult
    try {
      await held
      expect(await readFile(join(state.libraryDir, 'Renamed.mp4'), 'utf8')).toBe('video')
      expect(session.getTape(original.id)).toEqual(original)
      adoption = await handlers.get('library:import')!({ paths: [adoptPath] }) as ImportResult
      // Keep the real no-overwrite sidecar collision after refusal is fixed.
      // Before the fix, the importer itself already created this destination.
      await writeFile(join(state.libraryDir, 'Renamed.json'), independentSidecar, { flag: 'wx' })
        .catch((error: unknown) => {
          if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
        })
    } finally { release() }
    expect(await renaming).toBeInstanceOf(Error)

    const saved = SessionSchema.parse(JSON.parse(await readFile(state.catalog, 'utf8'))).tapes
    const files = await readdir(state.libraryDir)
    const missingMedia = saved.flatMap((tape) => tape.filename && !files.includes(tape.filename) ? [tape.filename] : [])
    expect.soft(adoption.imported).toEqual([])
    expect.soft(adoption.issues.map((issue) => issue.reason.key)).toEqual(['import.nameTaken'])
    expect.soft(missingMedia).toEqual([])
    expect.soft(saved).toEqual([original])
    expect(session.getTape(original.id)).toEqual(original)
    expect(await readFile(join(state.libraryDir, 'Original.mp4'), 'utf8')).toBe('video')
    expect(await readFile(join(state.libraryDir, 'Original.json'), 'utf8')).toBe(originalSidecar)
    expect(await readFile(adoptPath, 'utf8')).toBe(independentSidecar)
    expect(await readFile(join(state.libraryDir, 'Renamed.json'), 'utf8')).toBe(independentSidecar)
    expect(files).not.toContain('Renamed.mp4')

    // Once rollback settles, the same filename may serve a complete unrelated
    // bundle rather than remaining permanently reserved by the failed rename.
    await writeFile(join(state.libraryDir, 'Renamed.mp4'), 'independent media', { flag: 'wx' })
    const imported = await handlers.get('library:import')!({ paths: [join(state.libraryDir, 'Renamed.json')] }) as ImportResult
    expect.soft(imported.imported).toHaveLength(1)
    expect.soft(imported.issues).toEqual([])
    expect.soft(imported.imported[0]).toMatchObject({ sourceUrl: 'https://example.test/independent', filename: 'Renamed.mp4' })
    const finalSaved = SessionSchema.parse(JSON.parse(await readFile(state.catalog, 'utf8'))).tapes
    expect(finalSaved).toEqual(session.getTapes())
    const finalFiles = await readdir(state.libraryDir)
    expect(finalSaved.every((tape) => tape.filename && finalFiles.includes(tape.filename))).toBe(true)
  })

  it('returns and emits the canonical row with organization changes authored during its required write', async () => {
    let started!: () => void
    let release!: () => void
    const held = new Promise<void>((resolve) => { started = resolve })
    state.release = new Promise<void>((resolve) => { release = resolve })
    state.started = started
    state.holdRename = true
    const renaming = handlers.get('library:rename')!({ tapeId: original.id, name: 'Renamed' })
    try {
      await held
      expect(session.getTape(original.id)?.filename).toBe('Original.mp4')
      session.upsertBox({ id: 'keepers123', name: 'Keepers', order: 0 })
      const current = session.getTape(original.id)!
      session.upsertTape({ ...current, archivedAtUtc: '2026-01-02T00:00:00.000Z', boxId: 'keepers123', order: -12 })
    } finally { release() }
    const returned = await renaming as Tape
    const current = session.getTape(original.id)!

    expect(current).toMatchObject({ filename: 'Renamed.mp4', sidecarFilename: 'Renamed.json', boxId: 'keepers123', order: -12 })
    expect(returned).toEqual(current)
    expect(emit).toHaveBeenCalledExactlyOnceWith('tapes:updated', current)
    await session.persistNow()
    expect(SessionSchema.parse(JSON.parse(await readFile(state.catalog, 'utf8'))).tapes).toEqual([current])
    expect((await readdir(state.libraryDir)).sort()).toEqual(['Renamed.json', 'Renamed.mp4'])
  })

  it('returns the current row when newer organization changes arrive during post-commit source cleanup', async () => {
    let started!: () => void
    let release!: () => void
    const held = new Promise<void>((resolve) => { started = resolve })
    state.release = new Promise<void>((resolve) => { release = resolve })
    state.started = started
    state.holdCleanup = true
    const renaming = handlers.get('library:rename')!({ tapeId: original.id, name: 'Renamed' })
    try {
      await held
      const committed = session.getTape(original.id)!
      expect(committed.filename).toBe('Renamed.mp4')
      expect(emit).toHaveBeenCalledExactlyOnceWith('tapes:updated', committed)
      session.upsertTape({ ...committed, archivedAtUtc: '2026-01-02T00:00:00.000Z', order: -9 })
    } finally { release() }
    const returned = await renaming as Tape

    expect(returned).toEqual(session.getTape(original.id))
    expect(returned).toMatchObject({ filename: 'Renamed.mp4', archivedAtUtc: '2026-01-02T00:00:00.000Z', order: -9 })
  })
})
