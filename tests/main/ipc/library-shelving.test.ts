import { librarySourceIndex } from '@shared/source-identity'
import type { SourceRef } from '@shared/source-identity'
vi.mock('@main/ipc/trust', () => ({ isTrustedApplicationSender: () => true }))
import { unwrapIpcReply, type IpcReply } from '@shared/ipc-reply'
import { access, mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Tape } from '@shared/domain'
import { cancelAllWork, resumeWork } from '@main/work-registry'
import { until } from '../../helpers/until'

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
      handlers.set(channel, async (req: unknown) => unwrapIpcReply(channel, (await fn({}, req)) as IpcReply<unknown>))
    },
  },
  shell,
}))

const state = vi.hoisted(() => ({ libraryDir: '', tapes: [] as Tape[], trashOnRemove: false, readdirFailurePath: '', readdirFailureCode: '' }))
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return {
    ...actual,
    readdir: ((...args: Parameters<typeof actual.readdir>) => {
      if (args[0] === state.readdirFailurePath) {
        return Promise.reject(Object.assign(new Error(`${state.readdirFailureCode}: scandir failed`), { code: state.readdirFailureCode }))
      }
      return actual.readdir(...args)
    }) as typeof actual.readdir,
  }
})
const emit = vi.hoisted(() => vi.fn())
const reorderTapesDurably = vi.hoisted(() => vi.fn())
const releaseHold = vi.hoisted(() => vi.fn())
const queueManager = vi.hoisted(() => ({ isActive: vi.fn((_id: string) => false), cancel: vi.fn(async (_id: string) => {}), holdFromScheduling: vi.fn((_ids: Iterable<string>) => releaseHold) }))
const log = vi.hoisted(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }))

const persistNow = vi.hoisted(() => vi.fn(async () => {}))
vi.mock('@main/store/session', () => ({
  sourceOwner: (ref: SourceRef, exceptId?: string) => librarySourceIndex(state.tapes, exceptId).find(ref),
  onCatalogSaveFailure: () => {},
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
vi.mock('@main/services/ytdlp', () => ({ downloadThumbnail: vi.fn(), probe: vi.fn() }))
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
    boxId: null, order: 0, pausedAtUtc: null, failedAtUtc: null, failureCode: null, lastError: null,
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
  queueManager.cancel.mockImplementation(async () => {})
  persistNow.mockImplementation(async () => {})
  state.libraryDir = await mkdtemp(join(tmpdir(), 'tapebox-library-shelving-'))
  state.trashOnRemove = false
  state.readdirFailurePath = ''
  state.readdirFailureCode = ''
  state.tapes = []
  registerLibraryHandlers()
})

afterEach(async () => {
  // A test that quits closes the work registry; reopen it for the next one.
  resumeWork()
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
    expect(emitted('tapes:updated')).toEqual([])
    expect(emitted('tapes:updatedMany')).toEqual([[[state.tapes[2], state.tapes[1]]]])
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
    expect(emitted('tapes:updated')).toEqual([])
    expect(emitted('tapes:updatedMany')).toEqual([[[state.tapes[1], state.tapes[2]]]])
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

/** A tape's own folder inside the library. */
function folder(id: string): string {
  return join(state.libraryDir, id)
}

describe('removing tapes from the library', () => {
  async function stageFiles(id: string, stem = id): Promise<Tape> {
    await mkdir(folder(id), { recursive: true })
    for (const name of [`${stem}.mp4`, `${stem}.json`, `${stem}.jpg`]) {
      await writeFile(join(folder(id), name), name.endsWith('.json') ? '{"formatVersion":1}' : 'content', 'utf8')
    }
    return makeTape({ id, filename: `${stem}.mp4`, sidecarFilename: `${stem}.json`, thumbnailFilename: `${stem}.jpg` })
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
    expect((await readdir(folder('Keepfiles1'))).sort()).toEqual(['Keepfiles1.jpg', 'Keepfiles1.json', 'Keepfiles1.mp4'])
  })

  it('deletes the tape\'s folder with its media, sidecar, poster and everything a download left there', async () => {
    state.tapes = [await stageFiles('Deletethem')]
    for (const name of ['Deletethem.f137.mp4.part', 'Deletethem.mp4.ytdl', 'Deletethem.f140.m4a.frag3', 'Deletethem.info.json', 'Deletethem.webp']) {
      await writeFile(join(folder('Deletethem'), name), 'leftover', 'utf8')
    }
    await mkdir(folder('Other00001'))
    await writeFile(join(folder('Other00001'), 'Other00001.mp4'), 'another tape', 'utf8')

    await invoke('library:remove', { tapeIds: ['Deletethem'], deleteFiles: true })

    expect(await readdir(state.libraryDir)).toEqual(['Other00001'])
    expect(shell.trashItem).not.toHaveBeenCalled()
  })

  it('leaves another tape\'s folder alone even when its files have the same names', async () => {
    state.tapes = [await stageFiles('Removeme01', 'Take'), await stageFiles('Sametake01', 'Take')]

    await invoke('library:remove', { tapeIds: ['Removeme01'], deleteFiles: true })

    expect(await readdir(state.libraryDir)).toEqual(['Sametake01'])
    expect((await readdir(folder('Sametake01'))).sort()).toEqual(['Take.jpg', 'Take.json', 'Take.mp4'])
  })

  it('trashes a finished bundle the catalog never named, and deletes fragments outright', async () => {
    state.trashOnRemove = true
    state.tapes = [makeTape({ id: 'Uncommit01', state: 'queued', filename: null, downloadedAtUtc: null })]
    await mkdir(folder('Uncommit01'))
    for (const name of ['Uncommit01.mp4', 'Uncommit01.json', 'Uncommit01.jpg', 'Uncommit01.f137.mp4.part']) {
      await writeFile(join(folder('Uncommit01'), name), 'content', 'utf8')
    }

    await invoke('library:remove', { tapeIds: ['Uncommit01'], deleteFiles: true })

    expect(shell.trashItem.mock.calls.map((call) => call[0])).toEqual([folder('Uncommit01')])
    expect((await readdir(folder('Uncommit01'))).sort(), 'the fragment is gone; the trashed folder is the fake Trash\'s').toEqual(
      ['Uncommit01.jpg', 'Uncommit01.json', 'Uncommit01.mp4'],
    )
    expect(state.tapes).toEqual([])
  })

  it('keeps every bundle file when its sidecar is from a newer TapeBox', async () => {
    const tape = await stageFiles('Protected1')
    state.tapes = [tape]
    await writeFile(join(folder('Protected1'), 'Protected1.json'), '{"formatVersion":2}')
    await expect(invoke('library:remove', { tapeIds: ['Protected1'], deleteFiles: true })).rejects.toThrow('could not be removed')
    expect(state.tapes).toEqual([tape])
    expect((await readdir(folder('Protected1'))).sort()).toEqual(['Protected1.jpg', 'Protected1.json', 'Protected1.mp4'])
    expect(shell.trashItem).not.toHaveBeenCalled()
    expect(emitted('tapes:removed')).toEqual([])
  })

  it('removes a tape and its files when its sidecar is damaged', async () => {
    state.tapes = [await stageFiles('Damaged001')]
    await writeFile(join(folder('Damaged001'), 'Damaged001.json'), 'unreadable')
    await invoke('library:remove', { tapeIds: ['Damaged001'], deleteFiles: true })
    expect(state.tapes).toEqual([])
    expect(await readdir(state.libraryDir)).toEqual([])
  })

  it('sends the folder to the Trash instead when the user asked for that, and skips one already gone', async () => {
    state.trashOnRemove = true
    state.tapes = [await stageFiles('Trashthese'), makeTape({ id: 'Nofolder01', filename: 'Nofolder01.mp4' })]

    await invoke('library:remove', { tapeIds: ['Trashthese', 'Nofolder01'], deleteFiles: true })

    expect(shell.trashItem.mock.calls.map((call) => call[0])).toEqual([folder('Trashthese')])
    expect(state.tapes).toEqual([])
  })

  it('removes a folder that held only download fragments instead of trashing it', async () => {
    state.trashOnRemove = true
    state.tapes = [makeTape({ id: 'Fragsonly1', state: 'queued', filename: null, downloadedAtUtc: null })]
    await mkdir(folder('Fragsonly1'))
    await writeFile(join(folder('Fragsonly1'), 'Fragsonly1.f137.mp4.part'), 'partial', 'utf8')

    await invoke('library:remove', { tapeIds: ['Fragsonly1'], deleteFiles: true })

    expect(shell.trashItem).not.toHaveBeenCalled()
    expect(await readdir(state.libraryDir)).toEqual([])
    expect(state.tapes).toEqual([])
  })

  it.each(['EACCES', 'EIO'])('keeps the catalog row and files when the tape folder cannot be read (%s)', async (code) => {
    state.trashOnRemove = true
    const tape = await stageFiles('Readfailed')
    state.tapes = [tape]
    state.readdirFailurePath = folder('Readfailed')
    state.readdirFailureCode = code

    await expect(invoke('library:remove', { tapeIds: [tape.id], deleteFiles: true })).rejects.toMatchObject({
      userMessage: { key: 'errors.removeFilesKept' },
    })
    state.readdirFailurePath = ''
    expect(state.tapes).toEqual([tape])
    expect((await readdir(folder('Readfailed'))).sort()).toEqual(['Readfailed.jpg', 'Readfailed.json', 'Readfailed.mp4'])
    expect(shell.trashItem).not.toHaveBeenCalled()
    expect(emitted('tapes:removed')).toEqual([])
    expect(log.error).toHaveBeenCalledWith('library removal failed', expect.objectContaining({
      tapeId: tape.id, error: expect.objectContaining({ message: expect.stringContaining(code) }),
    }))
  })

  it('stops a running download before the tape goes, with the batch held out of scheduling', async () => {
    state.tapes = [makeTape({ id: 'Downloading' }), makeTape({ id: 'Queuednext', state: 'queued' })]
    queueManager.isActive.mockImplementation((id: string) => id === 'Downloading')

    await invoke('library:remove', { tapeIds: ['Downloading', 'Queuednext'], deleteFiles: true })

    expect(queueManager.cancel).toHaveBeenCalledExactlyOnceWith('Downloading')
    expect([...queueManager.holdFromScheduling.mock.calls[0]![0]]).toEqual(['Downloading', 'Queuednext'])
    expect(queueManager.holdFromScheduling.mock.invocationCallOrder[0]!).toBeLessThan(queueManager.cancel.mock.invocationCallOrder[0]!)
    // Released only once the rows are gone, so a tick then cannot start them.
    expect(releaseHold).toHaveBeenCalledOnce()
    expect(releaseHold.mock.invocationCallOrder[0]!).toBeGreaterThan(persistNow.mock.invocationCallOrder[0]!)
    expect(state.tapes).toEqual([])
  })

  it('discards a download that finalized and committed while it was being cancelled', async () => {
    state.tapes = [makeTape({ id: 'Latefinish', state: 'downloading', filename: null, downloadedAtUtc: null })]
    queueManager.isActive.mockReturnValue(true)
    queueManager.cancel.mockImplementation(async (id: string) => {
      await mkdir(folder(id))
      for (const name of [`${id}.mp4`, `${id}.json`, `${id}.jpg`]) await writeFile(join(folder(id), name), name.endsWith('.json') ? '{"formatVersion":1}' : 'finished', 'utf8')
      state.tapes = state.tapes.map((tape) => tape.id === id
        ? { ...tape, state: 'downloaded', filename: `${id}.mp4`, sidecarFilename: `${id}.json`, thumbnailFilename: `${id}.jpg` }
        : tape)
    })

    await invoke('library:remove', { tapeIds: ['Latefinish'], deleteFiles: true })

    expect(await readdir(state.libraryDir)).toEqual([])
    expect(state.tapes).toEqual([])
  })

  it('holds a quit until the removal and its catalog commit have settled', async () => {
    state.tapes = [await stageFiles('Quitwaits1')]
    let commit!: () => void
    persistNow.mockImplementation(() => new Promise<void>((resolve) => { commit = resolve }))

    const removal = invoke('library:remove', { tapeIds: ['Quitwaits1'], deleteFiles: true })
    await until(() => expect(persistNow).toHaveBeenCalledOnce())
    let quitDone = false
    const quit = cancelAllWork().then(() => { quitDone = true })
    await new Promise((resolve) => setImmediate(resolve))
    expect(quitDone, 'the quit waits for the removal').toBe(false)

    commit()
    await removal
    await quit
    expect(await readdir(state.libraryDir)).toEqual([])
    expect(emitted('tapes:removed')).toEqual([[{ tapeIds: ['Quitwaits1'] }]])
  })

  it('keeps the entry and says so when the files cannot be discarded, and still removes the rest', async () => {
    state.trashOnRemove = true
    state.tapes = [await stageFiles('Stuckhere1'), await stageFiles('Removable1')]
    shell.trashItem.mockImplementation(async (path: string) => {
      if (path.includes('Stuckhere1')) throw new Error('EPERM: operation not permitted')
    })

    await expect(invoke('library:remove', { tapeIds: ['Stuckhere1', 'Removable1'], deleteFiles: true })).rejects.toThrow(
      'The files for 1 tape could not be removed. The library entries were kept.',
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
    await mkdir(folder('Hassidecar'))
    await writeFile(join(folder('Hassidecar'), 'Take.json'), JSON.stringify({ formatVersion: 1, title: 'Take', description: 'note' }), 'utf8')
    state.tapes = [makeTape({ id: 'Hassidecar', sidecarFilename: 'Take.json' })]

    await expect(invoke('library:getSidecar', { tapeId: 'Hassidecar' })).resolves.toEqual({
      formatVersion: 1,
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
    await expect(access(join(folder('Brokenside'), 'missing.json'))).rejects.toThrow()
  })
})
