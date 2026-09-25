import { access, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Tape } from '@shared/domain'

// Moving tapes between the inbox and the archive, and taking them out of the
// library altogether. The library directory is real — a removal that claims to
// have deleted files has to have deleted them — while the catalog is a working
// fake so the orders these handlers write can be read back.
const handlers = new Map<string, (req: unknown) => unknown>()
const shell = vi.hoisted(() => ({
  showItemInFolder: vi.fn(),
  openPath: vi.fn(),
  trashItem: vi.fn(async (_path: string) => {}),
}))
vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, fn: (event: unknown, req: unknown) => unknown) => {
      handlers.set(channel, (req) => fn({}, req))
    },
  },
  shell,
}))

const state = vi.hoisted(() => ({ libraryDir: '', tapes: [] as Tape[], trashOnRemove: false }))
const emit = vi.hoisted(() => vi.fn())
const reorderTapesDurably = vi.hoisted(() => vi.fn())
const queueManager = vi.hoisted(() => ({ isActive: vi.fn(() => false), cancel: vi.fn(async () => {}) }))
const clearPartials = vi.hoisted(() => vi.fn(async () => {}))
const log = vi.hoisted(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }))

const persistNow = vi.hoisted(() => vi.fn(async () => {}))
vi.mock('@main/store/session', () => ({
  persistNow,
  getTape: (id: string) => state.tapes.find((tape) => tape.id === id),
  getTapes: () => state.tapes,
  getBoxes: () => [],
  upsertTape: (tape: Tape) => {
    state.tapes = state.tapes.map((candidate) => (candidate.id === tape.id ? tape : candidate))
  },
  removeTapes: (ids: string[]) => {
    state.tapes = state.tapes.filter((tape) => !ids.includes(tape.id))
  },
  reorderTapesDurably,
}))
vi.mock('@main/store/config', () => ({
  getLibraryDir: () => state.libraryDir,
  getSettings: () => ({ trashOnRemove: state.trashOnRemove, externalPlayer: '' }),
}))
vi.mock('@main/queue/manager', () => queueManager)
vi.mock('@main/services/ytdlp', () => ({ clearPartials, downloadThumbnail: vi.fn(), probe: vi.fn() }))
vi.mock('@main/services/ffmpeg', () => ({ saveThumbnailJpeg: vi.fn() }))
vi.mock('@main/io/logger', () => ({ log }))
vi.mock('@main/ipc/events', () => ({ emit }))

const { registerLibraryHandlers } = await import('@main/ipc/library')

function makeTape(overrides: Partial<Tape> & { id: string }): Tape {
  return {
    sourceUrl: 'https://example.test/watch', state: 'downloaded',
    addedAtUtc: '2026-01-01T00:00:00.000Z', sourceId: 'source', extractor: 'test',
    title: 'Title', uploader: 'Uploader', durationSeconds: 1, chapterCount: 0,
    probedAtUtc: '2026-01-01T00:00:00.000Z', filename: null,
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

/** The tapes in one list, top first, as `id@order`. */
function listing(where: 'inbox' | 'unboxed'): string[] {
  return state.tapes
    .filter((tape) => (where === 'inbox' ? tape.archivedAtUtc === null : tape.archivedAtUtc !== null && tape.boxId === null))
    .sort((a, b) => a.order - b.order)
    .map((tape) => `${tape.id}@${tape.order}`)
}

function emitted(channel: string): unknown[][] {
  return emit.mock.calls.filter((call) => call[0] === channel).map((call) => call.slice(1))
}

beforeEach(async () => {
  handlers.clear()
  vi.clearAllMocks()
  queueManager.isActive.mockReturnValue(false)
  state.libraryDir = await mkdtemp(join(tmpdir(), 'tapebox-library-shelving-'))
  state.trashOnRemove = false
  state.tapes = []
  registerLibraryHandlers()
})

afterEach(async () => {
  await rm(state.libraryDir, { recursive: true, force: true })
})

describe('archiving', () => {
  it('files the selection into Unboxed on top, in the order it was selected', async () => {
    state.tapes = [
      makeTape({ id: 'already-filed', archivedAtUtc: '2026-01-02T00:00:00.000Z', order: 0 }),
      makeTape({ id: 'inbox-a', order: 1 }),
      makeTape({ id: 'inbox-b', order: 2 }),
    ]

    await invoke('library:archive', { tapeIds: ['inbox-b', 'inbox-a'] })

    expect(listing('unboxed')).toEqual(['inbox-b@-2', 'inbox-a@-1', 'already-filed@0'])
    expect(listing('inbox')).toEqual([])
    expect(emitted('tapes:updated')).toHaveLength(2)
  })

  it('leaves an already-archived tape where it is', async () => {
    const filed = makeTape({ id: 'already-filed', archivedAtUtc: '2026-01-02T00:00:00.000Z', boxId: 'box-summer', order: 4 })
    state.tapes = [filed]

    await invoke('library:archive', { tapeIds: ['already-filed', 'not-a-tape'] })

    expect(state.tapes[0], 'its box and place are not disturbed').toBe(filed)
    expect(emit).not.toHaveBeenCalled()
  })
})

describe('unarchiving', () => {
  it('returns the selection to the top of the inbox and drops its box', async () => {
    state.tapes = [
      makeTape({ id: 'inbox-old', order: 0 }),
      makeTape({ id: 'filed-a', archivedAtUtc: '2026-01-02T00:00:00.000Z', boxId: 'box-summer', order: 0 }),
      makeTape({ id: 'filed-b', archivedAtUtc: '2026-01-02T00:00:00.000Z', boxId: 'box-summer', order: 1 }),
    ]

    await invoke('library:unarchive', { tapeIds: ['filed-a', 'filed-b'] })

    expect(listing('inbox')).toEqual(['filed-a@-2', 'filed-b@-1', 'inbox-old@0'])
    expect(state.tapes.every((tape) => tape.boxId === null)).toBe(true)
    expect(emitted('tapes:updated')).toHaveLength(2)
  })

  it('leaves a tape that is already in the inbox alone', async () => {
    const inbox = makeTape({ id: 'inbox-old', order: 7 })
    state.tapes = [inbox]

    await invoke('library:unarchive', { tapeIds: ['inbox-old'] })

    expect(state.tapes[0]).toBe(inbox)
    expect(emit).not.toHaveBeenCalled()
  })
})

describe('reordering one list by hand', () => {
  it('announces what the session committed', async () => {
    reorderTapesDurably.mockResolvedValue([makeTape({ id: 'inbox-a', order: 0 })])

    await invoke('tapes:reorder', { orderedIds: ['inbox-a', 'inbox-b'] })

    expect(reorderTapesDurably).toHaveBeenCalledExactlyOnceWith(['inbox-a', 'inbox-b'])
    expect(emitted('tapes:updatedMany')).toHaveLength(1)
  })

  it('stays quiet when nothing moved', async () => {
    reorderTapesDurably.mockResolvedValue([])

    await invoke('tapes:reorder', { orderedIds: ['inbox-a'] })

    expect(emitted('tapes:updatedMany')).toEqual([])
  })
})

describe('removing tapes from the library', () => {
  async function stageFiles(id: string): Promise<Tape> {
    for (const name of [`${id}.mp4`, `${id}.json`, `${id}.jpg`]) {
      await writeFile(join(state.libraryDir, name), 'content', 'utf8')
    }
    return makeTape({ id, filename: `${id}.mp4`, sidecarFilename: `${id}.json`, thumbnailFilename: `${id}.jpg` })
  }

  it('takes the entries out and leaves the files when the user keeps them', async () => {
    state.tapes = [await stageFiles('Keepfiles1')]

    await invoke('library:remove', { tapeIds: ['Keepfiles1'], deleteFiles: false })

    expect(state.tapes).toEqual([])
    expect(emitted('tapes:removed')).toEqual([[{ tapeIds: ['Keepfiles1'] }]])
    // The removal is durable before it is announced.
    expect(persistNow.mock.invocationCallOrder[0]!).toBeLessThan(
      emit.mock.invocationCallOrder[emit.mock.calls.findIndex((call) => call[0] === 'tapes:removed')]!,
    )
    expect((await readdir(state.libraryDir)).sort()).toEqual(['Keepfiles1.jpg', 'Keepfiles1.json', 'Keepfiles1.mp4'])
    expect(clearPartials).not.toHaveBeenCalled()
  })

  it('deletes the media, sidecar, poster and any half-finished fragments', async () => {
    state.tapes = [await stageFiles('Deletethem')]

    await invoke('library:remove', { tapeIds: ['Deletethem'], deleteFiles: true })

    expect(await readdir(state.libraryDir)).toEqual([])
    expect(clearPartials).toHaveBeenCalledExactlyOnceWith(state.libraryDir, 'Deletethem')
    expect(shell.trashItem).not.toHaveBeenCalled()
  })

  it('sends the files to the Trash instead when the user asked for that, and skips ones already gone', async () => {
    state.trashOnRemove = true
    const tape = await stageFiles('Trashthese')
    state.tapes = [tape]
    await rm(join(state.libraryDir, 'Trashthese.jpg'))

    await invoke('library:remove', { tapeIds: ['Trashthese'], deleteFiles: true })

    expect(shell.trashItem.mock.calls.map((call) => call[0]).sort()).toEqual([
      join(state.libraryDir, 'Trashthese.json'),
      join(state.libraryDir, 'Trashthese.mp4'),
    ])
    expect(state.tapes).toEqual([])
  })

  it('stops a running download before the tape goes', async () => {
    state.tapes = [makeTape({ id: 'Downloading' })]
    queueManager.isActive.mockReturnValue(true)

    await invoke('library:remove', { tapeIds: ['Downloading'], deleteFiles: true })

    expect(queueManager.cancel).toHaveBeenCalledExactlyOnceWith('Downloading')
    expect(state.tapes).toEqual([])
  })

  it('keeps the entry and says so when the files cannot be discarded, and still removes the rest', async () => {
    state.trashOnRemove = true
    state.tapes = [await stageFiles('Stuckhere1'), await stageFiles('Removable1')]
    shell.trashItem.mockImplementation(async (path: string) => {
      if (path.includes('Stuckhere1')) throw new Error('EPERM: operation not permitted')
    })

    await expect(invoke('library:remove', { tapeIds: ['Stuckhere1', 'Removable1'], deleteFiles: true })).rejects.toThrow(
      'The operation could not be completed.',
    )

    expect(state.tapes.map((tape) => tape.id), 'the tape whose files stayed is kept').toEqual(['Stuckhere1'])
    expect(emitted('tapes:removed')).toEqual([[{ tapeIds: ['Removable1'] }]])
    expect(log.error).toHaveBeenCalledWith('library removal failed', expect.objectContaining({ tapeId: 'Stuckhere1' }))
  })

  it('skips ids the catalog no longer holds', async () => {
    state.tapes = [makeTape({ id: 'Stillhere1' })]

    await invoke('library:remove', { tapeIds: ['gone-already'], deleteFiles: true })

    expect(state.tapes.map((tape) => tape.id)).toEqual(['Stillhere1'])
    expect(emit).not.toHaveBeenCalled()
  })
})

describe('reading a tape sidecar', () => {
  it('hands back the parsed sidecar', async () => {
    await writeFile(join(state.libraryDir, 'Take.json'), JSON.stringify({ title: 'Take', description: 'note' }), 'utf8')
    state.tapes = [makeTape({ id: 'Hassidecar', sidecarFilename: 'Take.json' })]

    await expect(invoke('library:getSidecar', { tapeId: 'Hassidecar' })).resolves.toEqual({
      title: 'Take',
      description: 'note',
    })
  })

  it('refuses when the tape has no sidecar, and when there is no such tape', async () => {
    state.tapes = [makeTape({ id: 'Nosidecar1' })]

    await expect(invoke('library:getSidecar', { tapeId: 'Nosidecar1' })).rejects.toThrow('The operation could not be completed.')
    await expect(invoke('library:getSidecar', { tapeId: 'not-a-tape' })).rejects.toThrow('The operation could not be completed.')
  })

  it('reports the file behind a sidecar that cannot be read', async () => {
    state.tapes = [makeTape({ id: 'Brokenside', sidecarFilename: 'missing.json' })]

    await expect(invoke('library:getSidecar', { tapeId: 'Brokenside' })).rejects.toThrow()
    await expect(access(join(state.libraryDir, 'missing.json'))).rejects.toThrow()
  })
})
