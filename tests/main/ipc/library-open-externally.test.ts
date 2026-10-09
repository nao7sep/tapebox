import { unwrapIpcReply, type IpcReply } from '@shared/ipc-reply'
import { join } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Tape } from '@shared/domain'

// Handing a tape to the OS: reveal it in the file manager, or play it in the
// user's own player. The two things that must not go wrong are the path handed
// over and the failure the user is told about.
const handlers = new Map<string, (req: unknown) => unknown>()
const shell = vi.hoisted(() => ({
  showItemInFolder: vi.fn(),
  openPath: vi.fn(async () => ''),
  trashItem: vi.fn(),
}))
vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, fn: (event: unknown, req: unknown) => unknown) => {
      handlers.set(channel, async (req: unknown) => unwrapIpcReply(channel, (await fn({}, req)) as IpcReply<unknown>))
    },
  },
  shell,
}))

const openExternalPlayer = vi.hoisted(() => vi.fn(async () => {}))
vi.mock('@main/io/external-player', () => ({ openExternalPlayer }))

const state = vi.hoisted(() => ({ libraryDir: '/library', tapes: [] as Tape[], externalPlayer: '' }))
const log = vi.hoisted(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }))

vi.mock('@main/store/session', () => ({
  onCatalogSaveFailure: () => {},
  getTape: (id: string) => state.tapes.find((tape) => tape.id === id),
  getTapes: () => state.tapes,
  getBoxes: () => [],
  upsertTape: vi.fn(),
  removeTapes: vi.fn(),
  reorderTapesDurably: vi.fn(),
}))
vi.mock('@main/store/config', () => ({
  getLibraryDir: () => state.libraryDir,
  getSettings: () => ({ trashOnRemove: false, externalPlayer: state.externalPlayer }),
}))
vi.mock('@main/queue/manager', () => ({ isActive: vi.fn(() => false), cancel: vi.fn() }))
vi.mock('@main/services/ytdlp', () => ({ downloadThumbnail: vi.fn(), probe: vi.fn() }))
vi.mock('@main/services/ffmpeg', () => ({ saveThumbnailJpeg: vi.fn() }))
vi.mock('@main/io/logger', () => ({ log }))
vi.mock('@main/ipc/events', () => ({ emit: vi.fn() }))

const { registerLibraryHandlers } = await import('@main/ipc/library')

const FULL_PATH = join('/library', 'Take.mp4')
function makeTape(overrides: Partial<Tape> & { id: string }): Tape {
  return {
    sourceUrl: 'https://example.test/watch', state: 'downloaded',
    addedAtUtc: '2026-01-01T00:00:00.000Z', sourceId: 'source', extractor: 'test',
    title: 'Title', uploader: 'Uploader', durationSeconds: 1, chapterCount: 0,
    probedAtUtc: '2026-01-01T00:00:00.000Z', filename: 'Take.mp4',
    sidecarFilename: null, thumbnailFilename: null,
    downloadStartedAtUtc: null, downloadedAtUtc: '2026-01-01T00:00:00.000Z',
    name: 'Take', renamedAtUtc: null, archivedAtUtc: null,
    boxId: null, order: 0, pausedAtUtc: null, failedAtUtc: null, failureCode: null, lastError: null,
    ...overrides,
  }
}

function invoke<T>(channel: string, req?: unknown): Promise<T> {
  const handler = handlers.get(channel)
  if (!handler) throw new Error(`${channel} was not registered`)
  return Promise.resolve(handler(req) as T)
}

beforeEach(() => {
  handlers.clear()
  vi.clearAllMocks()
  shell.openPath.mockResolvedValue('')
  openExternalPlayer.mockResolvedValue()
  state.externalPlayer = ''
  state.tapes = [makeTape({ id: 'Hasafile12' }), makeTape({ id: 'Nofileyet1', filename: null })]
  registerLibraryHandlers()
})

describe('revealing a tape in the file manager', () => {
  it('points the file manager at the file itself', async () => {
    await invoke('library:reveal', { tapeId: 'Hasafile12' })

    expect(shell.showItemInFolder).toHaveBeenCalledExactlyOnceWith(FULL_PATH)
  })

  it.each([
    ['a tape whose file is not downloaded yet', 'Nofileyet1'],
    ['a tape the catalog does not hold', 'not-a-tape'],
  ])('refuses for %s', async (_case, tapeId) => {
    await expect(invoke('library:reveal', { tapeId })).rejects.toThrow('The operation could not be completed.')
    expect(shell.showItemInFolder).not.toHaveBeenCalled()
  })
})

describe('playing a tape outside the app', () => {
  it('lets the OS choose the player when none is configured', async () => {
    await invoke('library:playExternal', { tapeId: 'Hasafile12' })

    expect(shell.openPath).toHaveBeenCalledExactlyOnceWith(FULL_PATH)
    expect(openExternalPlayer).not.toHaveBeenCalled()
  })

  it('passes on what the OS said when it could not open the file', async () => {
    shell.openPath.mockResolvedValue('No application is registered for .mp4')

    await expect(invoke('library:playExternal', { tapeId: 'Hasafile12' })).rejects.toThrow(
      'The operation could not be completed.',
    )
  })

  it('hands the chosen player the file', async () => {
    state.externalPlayer = '  IINA  '

    await invoke('library:playExternal', { tapeId: 'Hasafile12' })

    expect(openExternalPlayer).toHaveBeenCalledExactlyOnceWith('IINA', FULL_PATH)
    expect(shell.openPath).not.toHaveBeenCalled()
  })

  it('rejects the click when the configured player cannot start, keeping diagnostics out of the reply', async () => {
    state.externalPlayer = 'not-a-player'
    const error = Object.assign(new Error('ENOENT /internal/player SENTINEL'), { code: 'ENOENT' })
    openExternalPlayer.mockRejectedValue(error)

    await expect(invoke('library:playExternal', { tapeId: 'Hasafile12' })).rejects.toThrow('The operation could not be completed.')
    expect(log.error).toHaveBeenCalledWith('ipc handler failed', expect.objectContaining({
      channel: 'library:playExternal', error: expect.objectContaining({ message: expect.stringContaining('SENTINEL') }),
    }))
  })

  it.each([
    ['a tape whose file is not downloaded yet', 'Nofileyet1'],
    ['a tape the catalog does not hold', 'not-a-tape'],
  ])('refuses for %s', async (_case, tapeId) => {
    await expect(invoke('library:playExternal', { tapeId })).rejects.toThrow('The operation could not be completed.')
    expect(shell.openPath).not.toHaveBeenCalled()
    expect(openExternalPlayer).not.toHaveBeenCalled()
  })
})
