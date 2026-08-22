import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Tape } from '@shared/domain'

const handlers = new Map<string, (req: unknown) => unknown>()
vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, fn: (event: unknown, req: unknown) => unknown) => {
      handlers.set(channel, (req) => fn({}, req))
    },
  },
  shell: { showItemInFolder: vi.fn(), openPath: vi.fn(), trashItem: vi.fn() },
}))

const state = vi.hoisted(() => ({ tape: null as Tape | null, libraryDir: '' }))
const upsertTape = vi.hoisted(() => vi.fn((tape: Tape) => { state.tape = tape }))
vi.mock('@main/store/session', () => ({
  getTape: (id: string) => state.tape?.id === id ? state.tape : undefined,
  getTapes: () => state.tape ? [state.tape] : [],
  getBoxes: () => [],
  upsertTape,
  removeTapes: vi.fn(),
}))
vi.mock('@main/store/config', () => ({
  getLibraryDir: () => state.libraryDir,
  getSettings: () => ({ trashOnRemove: true, externalPlayer: '' }),
}))
vi.mock('@main/queue/manager', () => ({ isActive: vi.fn(() => false), cancel: vi.fn() }))
vi.mock('@main/services/ytdlp', () => ({
  clearPartials: vi.fn(), downloadThumbnail: vi.fn(), probe: vi.fn(),
}))
vi.mock('@main/services/ffmpeg', () => ({ saveThumbnailJpeg: vi.fn() }))
vi.mock('@main/io/logger', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))
vi.mock('@main/ipc/events', () => ({ emit: vi.fn() }))

const { registerLibraryHandlers } = await import('@main/ipc/library')

let dir: string

beforeEach(async () => {
  handlers.clear()
  upsertTape.mockClear()
  dir = await mkdtemp(join(tmpdir(), 'tapebox-rename-'))
  state.libraryDir = dir
  state.tape = {
    id: 'Abc123_-xy', sourceUrl: 'https://example.test/watch', state: 'downloaded',
    addedAtUtc: '2026-01-01T00:00:00.000Z', sourceId: 'source', extractor: 'test',
    title: 'Title', uploader: 'Uploader', durationSeconds: 1, chapterCount: 0,
    probedAtUtc: '2026-01-01T00:00:00.000Z', filename: 'Take.mp4',
    sidecarFilename: 'Take.json', thumbnailFilename: 'Take.jpg',
    downloadStartedAtUtc: null, downloadedAtUtc: '2026-01-01T00:00:00.000Z',
    name: 'Take', renamedAtUtc: null, archivedAtUtc: null, boxId: null, order: 0,
    pausedAtUtc: null, failedAtUtc: null, lastError: null,
  }
  await writeFile(join(dir, 'Take.mp4'), 'video')
  await writeFile(join(dir, 'Take.jpg'), 'poster')
  await writeFile(join(dir, 'Take.json'), JSON.stringify({
    tapebox: {
      sourceUrl: state.tape.sourceUrl, name: 'Take', addedAtUtc: state.tape.addedAtUtc,
      downloadedAtUtc: state.tape.downloadedAtUtc, renamedAtUtc: null, media: null,
      mediaFilename: 'Take.mp4', thumbnailFilename: 'Take.jpg',
    },
  }))
  registerLibraryHandlers()
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe('library:rename', () => {
  it('preserves every bundle member during a case-only rename', async () => {
    const rename = handlers.get('library:rename')
    if (!rename) throw new Error('library:rename was not registered')

    await rename({ tapeId: state.tape!.id, name: 'take' })

    expect((await readdir(dir)).sort()).toEqual(['take.jpg', 'take.json', 'take.mp4'])
    expect(await readFile(join(dir, 'take.mp4'), 'utf8')).toBe('video')
    expect(await readFile(join(dir, 'take.jpg'), 'utf8')).toBe('poster')
    expect(state.tape).toMatchObject({ name: 'take', filename: 'take.mp4', sidecarFilename: 'take.json' })
  })
})
