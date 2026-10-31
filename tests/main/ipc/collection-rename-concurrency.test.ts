vi.mock('@main/ipc/trust', () => ({ isTrustedApplicationSender: () => true }))
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Tape } from '@shared/domain'
import { tapeDir } from '@main/paths'
import { unwrapIpcReply, type IpcReply } from '@shared/ipc-reply'

const state = vi.hoisted(() => ({
  collectionDir: '', holdRename: false, holdCleanup: false,
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
vi.mock('@main/store/config', () => ({
  getCollectionDir: () => state.collectionDir,
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
      // The rename's required write is the tape's own tape.json naming it.
      const candidate = JSON.parse(args[1].toString('utf8')) as { name?: unknown }
      if (state.holdRename && candidate.name === 'Renamed') {
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
    unlinkFiles: async (...args: Parameters<typeof actual.unlinkFiles>) => {
      if (state.holdCleanup && args[0].includes(join(state.collectionDir, 'shelf', 'abc1234567', 'Original.mp4'))) {
        state.holdCleanup = false
        state.started()
        await state.release
      }
      return actual.unlinkFiles(...args)
    },
  }
})

import { registerCollectionHandlers } from '@main/ipc/collection'
import * as session from '@main/store/session'
import { sidecarFixture } from '../../helpers/file-header'

let root: string
let original: Tape
// The tape's own folder inside the collection, where its files live.
let tapeFolder: string

beforeEach(async () => {
  handlers.clear()
  emit.mockClear()
  root = await mkdtemp(join(tmpdir(), 'tapebox-rename-concurrency-'))
  state.collectionDir = join(root, 'collection')
  state.holdRename = false
  state.holdCleanup = false
  state.release = null
  await mkdir(state.collectionDir)
  await session.loadSession()
  original = {
    id: 'abc1234567', sourceUrl: 'https://example.test/clip', state: 'downloaded',
    addedAtUtc: '2026-01-01T00:00:00.000Z', addedIndex: 0, sourceId: null, extractor: null,
    title: 'Clip', uploader: null, durationSeconds: null, chapterCount: null,
    probedAtUtc: null, filename: 'Original.mp4', sidecarFilename: 'Original.json',
    thumbnailFilename: null, downloadStartedAtUtc: null, downloadedAtUtc: '2026-01-01T00:00:00.000Z',
    name: 'Original', renamedAtUtc: null, shelved: true, boxId: null, order: 0,
    pausedAtUtc: null, failedAtUtc: null, failureCode: null, lastError: null,
  }
  // Shelved, so its box and place are organization the rename must keep.
  tapeFolder = tapeDir(state.collectionDir, original)
  await mkdir(tapeFolder, { recursive: true })
  await writeFile(join(tapeFolder, original.filename!), 'video')
  await writeFile(join(tapeFolder, original.sidecarFilename!), JSON.stringify(sidecarFixture()))
  session.upsertTape(original)
  await session.persistNow()
  registerCollectionHandlers()
})

afterEach(async () => {
  await session.persistNow({ quitting: true })
  await rm(root, { recursive: true, force: true })
})

describe('rename publication across the real session commit', () => {
  it('returns and emits the canonical row with organization changes authored during its required write', async () => {
    let started!: () => void
    let release!: () => void
    const held = new Promise<void>((resolve) => { started = resolve })
    state.release = new Promise<void>((resolve) => { release = resolve })
    state.started = started
    state.holdRename = true
    const renaming = handlers.get('collection:rename')!({ tapeId: original.id, name: 'Renamed' })
    try {
      await held
      expect(session.getTape(original.id)?.filename).toBe('Original.mp4')
      session.upsertBox({ id: 'keepers123', name: 'Keepers', order: 0 })
      const current = session.getTape(original.id)!
      session.upsertTape({ ...current, boxId: 'keepers123', order: -12 })
    } finally { release() }
    const returned = await renaming as Tape
    const current = session.getTape(original.id)!

    expect(current).toMatchObject({ filename: 'Renamed.mp4', sidecarFilename: 'Renamed.json', boxId: 'keepers123', order: -12 })
    expect(returned).toEqual(current)
    expect(emit).toHaveBeenCalledExactlyOnceWith('tapes:updated', current)
    await session.persistNow()
    const saved = await session.readCollection(state.collectionDir)
    // shelf.json keeps the tape's place in its box, not the order number.
    expect(saved.session.tapes).toEqual([{ ...session.durableTape(current), order: 0 }])
    expect((await readdir(tapeFolder)).sort()).toEqual(['Renamed.json', 'Renamed.mp4', 'tape.json'])
  })

  it('returns the current row when newer organization changes arrive during post-commit source cleanup', async () => {
    let started!: () => void
    let release!: () => void
    const held = new Promise<void>((resolve) => { started = resolve })
    state.release = new Promise<void>((resolve) => { release = resolve })
    state.started = started
    state.holdCleanup = true
    const renaming = handlers.get('collection:rename')!({ tapeId: original.id, name: 'Renamed' })
    try {
      await held
      const committed = session.getTape(original.id)!
      expect(committed.filename).toBe('Renamed.mp4')
      expect(emit).toHaveBeenCalledExactlyOnceWith('tapes:updated', committed)
      session.upsertTape({ ...committed, order: -9 })
    } finally { release() }
    const returned = await renaming as Tape

    expect(returned).toEqual(session.getTape(original.id))
    expect(returned).toMatchObject({ filename: 'Renamed.mp4', shelved: true, order: -9 })
  })
})
