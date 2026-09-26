import { unwrapIpcReply, type IpcReply } from '@shared/ipc-reply'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
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

const child = vi.hoisted(() => ({ on: vi.fn(), unref: vi.fn() }))
const spawn = vi.hoisted(() => vi.fn(() => child))
vi.mock('node:child_process', () => ({ spawn }))

const state = vi.hoisted(() => ({ libraryDir: '/library', tapes: [] as Tape[], externalPlayer: '' }))
const log = vi.hoisted(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }))

vi.mock('@main/store/session', () => ({
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
vi.mock('@main/services/ytdlp', () => ({ clearPartials: vi.fn(), downloadThumbnail: vi.fn(), probe: vi.fn() }))
vi.mock('@main/services/ffmpeg', () => ({ saveThumbnailJpeg: vi.fn() }))
vi.mock('@main/io/logger', () => ({ log }))
vi.mock('@main/ipc/events', () => ({ emit: vi.fn() }))

const { registerLibraryHandlers } = await import('@main/ipc/library')

const FULL_PATH = join('/library', 'Take.mp4')
const realPlatform = process.platform

function asPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', { value: platform, configurable: true })
}

function makeTape(overrides: Partial<Tape> & { id: string }): Tape {
  return {
    sourceUrl: 'https://example.test/watch', state: 'downloaded',
    addedAtUtc: '2026-01-01T00:00:00.000Z', sourceId: 'source', extractor: 'test',
    title: 'Title', uploader: 'Uploader', durationSeconds: 1, chapterCount: 0,
    probedAtUtc: '2026-01-01T00:00:00.000Z', filename: 'Take.mp4',
    sidecarFilename: null, thumbnailFilename: null,
    downloadStartedAtUtc: null, downloadedAtUtc: '2026-01-01T00:00:00.000Z',
    name: 'Take', renamedAtUtc: null, archivedAtUtc: null,
    boxId: null, order: 0, pausedAtUtc: null, failedAtUtc: null, lastError: null,
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
  state.externalPlayer = ''
  state.tapes = [makeTape({ id: 'Hasafile12' }), makeTape({ id: 'Nofileyet1', filename: null })]
  registerLibraryHandlers()
})

afterEach(() => {
  Object.defineProperty(process, 'platform', { value: realPlatform, configurable: true })
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
    expect(spawn).not.toHaveBeenCalled()
  })

  it('passes on what the OS said when it could not open the file', async () => {
    shell.openPath.mockResolvedValue('No application is registered for .mp4')

    await expect(invoke('library:playExternal', { tapeId: 'Hasafile12' })).rejects.toThrow(
      'The operation could not be completed.',
    )
  })

  it('opens the chosen app with the file on macOS', async () => {
    asPlatform('darwin')
    state.externalPlayer = '  IINA  '

    await invoke('library:playExternal', { tapeId: 'Hasafile12' })

    expect(spawn).toHaveBeenCalledExactlyOnceWith('open', ['-a', 'IINA', FULL_PATH], { detached: true, stdio: 'ignore' })
    expect(child.unref, 'the player outlives this call').toHaveBeenCalledOnce()
    expect(shell.openPath).not.toHaveBeenCalled()
  })

  it('runs the configured executable directly elsewhere', async () => {
    asPlatform('win32')
    state.externalPlayer = 'C:\\Program Files\\VLC\\vlc.exe'

    await invoke('library:playExternal', { tapeId: 'Hasafile12' })

    expect(spawn).toHaveBeenCalledExactlyOnceWith('C:\\Program Files\\VLC\\vlc.exe', [FULL_PATH], {
      detached: true,
      stdio: 'ignore',
    })
  })

  it('logs a player that will not start rather than failing the click', async () => {
    state.externalPlayer = 'not-a-player'

    await invoke('library:playExternal', { tapeId: 'Hasafile12' })

    const onError = child.on.mock.calls.find((call) => call[0] === 'error')?.[1] as (err: Error) => void
    onError(new Error('ENOENT'))
    expect(log.error).toHaveBeenCalledWith('library:playExternal failed', expect.objectContaining({ player: 'not-a-player' }))
  })

  it.each([
    ['a tape whose file is not downloaded yet', 'Nofileyet1'],
    ['a tape the catalog does not hold', 'not-a-tape'],
  ])('refuses for %s', async (_case, tapeId) => {
    await expect(invoke('library:playExternal', { tapeId })).rejects.toThrow('The operation could not be completed.')
    expect(shell.openPath).not.toHaveBeenCalled()
    expect(spawn).not.toHaveBeenCalled()
  })
})
