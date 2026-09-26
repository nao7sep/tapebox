import { unwrapIpcReply, type IpcReply } from '@shared/ipc-reply'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Tape } from '@shared/domain'

// Importing a bundle someone exported: the sidecar names its media and poster,
// and this boundary decides what comes into the library, what is refused and
// what the user is told about the rest of their selection. Real files and real
// copies throughout; only the catalogue, the log and the event bus are stood in
// for, so an import that reports success has really landed on disk.
type ImportResult = { imported: Tape[]; issues: Array<{ path: string; reason: string; severity: string }> }

const handlers = new Map<string, (req: unknown) => unknown>()
vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, fn: (event: unknown, req: unknown) => unknown) => {
      handlers.set(channel, async (req: unknown) => unwrapIpcReply(channel, (await fn({}, req)) as IpcReply<unknown>))
    },
  },
  shell: { showItemInFolder: vi.fn(), openPath: vi.fn(), trashItem: vi.fn() },
}))

const state = vi.hoisted(() => ({ libraryDir: '', tapes: [] as Tape[] }))
const emit = vi.hoisted(() => vi.fn())
const log = vi.hoisted(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }))

const persistNow = vi.hoisted(() => vi.fn(async () => {}))
vi.mock('@main/store/session', () => ({
  onCatalogSaveFailure: () => {},
  persistNow,
  getTape: (id: string) => state.tapes.find((tape) => tape.id === id),
  getTapes: () => state.tapes,
  getBoxes: () => [],
  upsertTape: (tape: Tape) => {
    state.tapes = [...state.tapes.filter((candidate) => candidate.id !== tape.id), tape]
  },
  removeTapes: vi.fn(),
  reorderTapesDurably: vi.fn(),
}))
vi.mock('@main/store/config', () => ({
  getLibraryDir: () => state.libraryDir,
  getSettings: () => ({ trashOnRemove: false, externalPlayer: '' }),
}))
vi.mock('@main/queue/manager', () => ({ isActive: vi.fn(() => false), cancel: vi.fn() }))
vi.mock('@main/services/ytdlp', () => ({ clearPartials: vi.fn(), downloadThumbnail: vi.fn(), probe: vi.fn() }))
vi.mock('@main/services/ffmpeg', () => ({ saveThumbnailJpeg: vi.fn() }))
vi.mock('@main/io/logger', () => ({ log }))
vi.mock('@main/ipc/events', () => ({ emit }))

const { registerLibraryHandlers } = await import('@main/ipc/library')
const { withLibraryMove } = await import('@main/library-writes')

let root: string
let sourceDir: string

/** Writes a bundle beside its sidecar and returns the sidecar's path. */
async function stageBundle(options: {
  stem: string
  sourceUrl?: string
  sidecarName?: string
  mediaFilename?: string
  thumbnailFilename?: string | null
  withMedia?: boolean
  withThumbnail?: boolean
  dir?: string
  tapebox?: Record<string, unknown> | null
}): Promise<string> {
  const dir = options.dir ?? sourceDir
  const media = options.mediaFilename ?? `${options.stem}.mp4`
  const thumbnail = options.thumbnailFilename === undefined ? null : options.thumbnailFilename
  if (options.withMedia !== false) await writeFile(join(dir, media), `video for ${options.stem}`)
  if (thumbnail && options.withThumbnail !== false) await writeFile(join(dir, thumbnail), `poster for ${options.stem}`)
  const sidecarPath = join(dir, options.sidecarName ?? `${options.stem}.json`)
  const body =
    options.tapebox === null
      ? {}
      : {
          tapebox: {
            sourceUrl: options.sourceUrl ?? `https://example.test/${options.stem}`,
            name: options.stem,
            addedAtUtc: '2026-01-01T00:00:00.000Z',
            downloadedAtUtc: '2026-01-01T00:00:00.000Z',
            renamedAtUtc: null,
            media: null,
            mediaFilename: media,
            thumbnailFilename: thumbnail,
            ...options.tapebox,
          },
        }
  await writeFile(sidecarPath, JSON.stringify(body))
  return sidecarPath
}

function makeTape(overrides: Partial<Tape> & { id: string }): Tape {
  return {
    sourceUrl: 'https://example.test/existing', state: 'downloaded',
    addedAtUtc: '2026-01-01T00:00:00.000Z', sourceId: null, extractor: null,
    title: null, uploader: null, durationSeconds: null, chapterCount: null,
    probedAtUtc: null, filename: 'existing.mp4', sidecarFilename: 'existing.json',
    thumbnailFilename: null, downloadStartedAtUtc: null, downloadedAtUtc: null,
    name: null, renamedAtUtc: null, archivedAtUtc: null, boxId: null, order: 0,
    pausedAtUtc: null, failedAtUtc: null, lastError: null,
    ...overrides,
  }
}

function importPaths(...paths: string[]): Promise<ImportResult> {
  return Promise.resolve(handlers.get('library:import')!({ paths })) as Promise<ImportResult>
}

beforeEach(async () => {
  handlers.clear()
  vi.clearAllMocks()
  root = await mkdtemp(join(tmpdir(), 'tapebox-import-'))
  sourceDir = join(root, 'source')
  state.libraryDir = join(root, 'library')
  state.tapes = []
  await mkdir(sourceDir)
  await mkdir(state.libraryDir)
  registerLibraryHandlers()
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

describe('importing a bundle', () => {
  it('copies the media, sidecar and poster in, and puts the tape at the top of the inbox', async () => {
    const sidecar = await stageBundle({ stem: 'holiday', thumbnailFilename: 'holiday.jpg' })
    state.tapes = [makeTape({ id: 'already-here', order: 0 })]

    const result = await importPaths(sidecar, join(sourceDir, 'holiday.mp4'), join(sourceDir, 'holiday.jpg'))

    expect(result.issues).toEqual([])
    expect(result.imported).toHaveLength(1)
    const [tape] = result.imported
    expect(tape).toMatchObject({
      sourceUrl: 'https://example.test/holiday',
      filename: 'holiday.mp4',
      sidecarFilename: 'holiday.json',
      thumbnailFilename: 'holiday.jpg',
      archivedAtUtc: null,
    })
    expect(tape.order, 'it lands above what was already in the inbox').toBeLessThan(0)
    expect((await readdir(state.libraryDir)).sort()).toEqual(['holiday.jpg', 'holiday.json', 'holiday.mp4'])
    expect(await readFile(join(state.libraryDir, 'holiday.mp4'), 'utf8')).toBe('video for holiday')
    expect(state.tapes.map((entry) => entry.id)).toContain(tape.id)
    expect(emit).toHaveBeenCalledExactlyOnceWith('tapes:added', result.imported)
    // The imported rows are durable before they are announced.
    expect(persistNow).toHaveBeenCalled()
    expect(persistNow.mock.invocationCallOrder.at(-1)!).toBeLessThan(emit.mock.invocationCallOrder[0]!)
  })

  it('refuses a bundle whose file name another tape tracks, even when that file is gone from disk', async () => {
    // The existing tape's trip.mp4 was deleted outside the app, so only the catalog knows the name.
    state.tapes = [makeTape({ id: 'has-trip', filename: 'trip.mp4', sidecarFilename: 'has-trip.json' })]
    const sidecar = await stageBundle({ stem: 'trip', sourceUrl: 'https://example.test/other-trip' })

    const result = await importPaths(sidecar)

    expect(result.imported).toEqual([])
    expect(result.issues).toEqual([
      expect.objectContaining({ path: sidecar, severity: 'warning', reason: expect.stringContaining('trip.mp4') }),
    ])
    expect(await readdir(state.libraryDir)).toEqual([])
    expect(state.tapes.map((tape) => tape.id)).toEqual(['has-trip'])
  })

  it('imports without a thumbnail whose file name another tape tracks', async () => {
    state.tapes = [makeTape({ id: 'has-poster', thumbnailFilename: 'poster.jpg' })]
    const sidecar = await stageBundle({ stem: 'holiday', thumbnailFilename: 'poster.jpg' })

    const result = await importPaths(sidecar, join(sourceDir, 'holiday.mp4'), join(sourceDir, 'poster.jpg'))

    expect(result.imported).toHaveLength(1)
    expect(result.imported[0]!.thumbnailFilename).toBeNull()
    expect(result.issues).toEqual([expect.objectContaining({ path: join(sourceDir, 'poster.jpg'), severity: 'warning' })])
    expect((await readdir(state.libraryDir)).sort()).toEqual(['holiday.json', 'holiday.mp4'])
  })

  it('is refused while the library is being moved, and copies nothing into the old folder', async () => {
    const sidecar = await stageBundle({ stem: 'late' })
    let finishMove!: () => void
    const moving = withLibraryMove(() => new Promise<void>((resolve) => { finishMove = resolve }))

    await expect(importPaths(sidecar)).rejects.toThrow('The library is being moved to a new folder.')

    finishMove()
    await moving
    expect(await readdir(state.libraryDir)).toEqual([])
    expect(state.tapes).toEqual([])
  })

  it('reports a bundle of a video already in the library under a URL with tracking parameters', async () => {
    state.tapes = [makeTape({ id: 'already-in', sourceUrl: 'https://www.youtube.com/watch?v=X' })]
    const sidecar = await stageBundle({ stem: 'shared', sourceUrl: 'https://www.youtube.com/watch?v=X&si=abc' })

    const result = await importPaths(sidecar)

    expect(result.imported).toEqual([])
    expect(result.issues).toEqual([expect.objectContaining({ path: sidecar, reason: 'already in library' })])
    expect(await readdir(state.libraryDir)).toEqual([])
  })

  it('names the library copies after the media file, not after the sidecar', async () => {
    const sidecar = await stageBundle({ stem: 'holiday', sidecarName: 'renamed-by-hand.json' })

    const result = await importPaths(sidecar)

    expect(result.imported[0]).toMatchObject({ filename: 'holiday.mp4', sidecarFilename: 'holiday.json' })
    expect((await readdir(state.libraryDir)).sort()).toEqual(['holiday.json', 'holiday.mp4'])
  })

  it('keeps a batch in the order it was chosen, even when one of them is refused', async () => {
    const first = await stageBundle({ stem: 'first' })
    const broken = await stageBundle({ stem: 'broken', withMedia: false })
    const last = await stageBundle({ stem: 'last' })

    const result = await importPaths(first, broken, last)

    expect(result.imported.map((tape) => tape.filename)).toEqual(['first.mp4', 'last.mp4'])
    expect(result.imported[0].order).toBeLessThan(result.imported[1].order)
    expect(result.issues.map((issue) => issue.severity)).toEqual(['warning'])
  })

  it('takes nothing but leaves the tape usable when the poster cannot be found', async () => {
    const sidecar = await stageBundle({ stem: 'holiday', thumbnailFilename: 'holiday.jpg', withThumbnail: false })

    const result = await importPaths(sidecar)

    expect(result.imported[0].thumbnailFilename, 'the tape comes in without a poster').toBeNull()
    expect(result.issues.map((issue) => issue.reason)).toEqual([
      'The thumbnail could not be copied into the library. The tape was imported without it.',
    ])
  })

  it('imports a bundle that already sits in the library without copying over itself', async () => {
    const sidecar = await stageBundle({ stem: 'inplace', dir: state.libraryDir })

    const result = await importPaths(sidecar)

    expect(result.imported).toHaveLength(1)
    expect(await readFile(join(state.libraryDir, 'inplace.mp4'), 'utf8')).toBe('video for inplace')
  })
})

describe('what the import refuses, and what it says', () => {
  it('reports a sidecar it cannot read as an error', async () => {
    const result = await importPaths(join(sourceDir, 'gone.json'))

    expect(result.issues).toEqual([
      expect.objectContaining({ severity: 'error', reason: expect.stringContaining('could not be read') }),
    ])
    expect(log.error).toHaveBeenCalledWith('import sidecar read failed', expect.anything())
  })

  it('reports a sidecar that is not JSON', async () => {
    const sidecarPath = join(sourceDir, 'broken.json')
    await writeFile(sidecarPath, '{ not json')

    const result = await importPaths(sidecarPath)

    expect(result.issues).toEqual([
      expect.objectContaining({ severity: 'warning', reason: 'The sidecar is not valid TapeBox JSON.' }),
    ])
  })

  it.each([
    ['a sidecar from some other app', { tapebox: null }],
    ['one that names no media file', { tapebox: { mediaFilename: null } }],
    ['one whose source is not a link', { tapebox: { sourceUrl: 'not-a-url' } }],
  ])('refuses %s, naming what is wrong', async (_case, options) => {
    const sidecar = await stageBundle({ stem: 'odd', ...(options as { tapebox: Record<string, unknown> | null }) })

    const result = await importPaths(sidecar)

    expect(result.imported).toEqual([])
    expect(result.issues[0]).toMatchObject({ path: sidecar, severity: 'warning' })
    expect(result.issues[0].reason.length).toBeGreaterThan(10)
  })

  it('says a tape is already in the library rather than importing it twice', async () => {
    const sidecar = await stageBundle({ stem: 'holiday', sourceUrl: 'https://example.test/holiday' })
    state.tapes = [makeTape({ id: 'already-here', sourceUrl: 'https://example.test/holiday' })]

    const result = await importPaths(sidecar)

    expect(result.imported).toEqual([])
    expect(result.issues).toEqual([
      expect.objectContaining({ severity: 'information', reason: 'already in library' }),
    ])
    expect(await readdir(state.libraryDir)).toEqual([])
  })

  it('says which media file is missing beside its sidecar', async () => {
    const sidecar = await stageBundle({ stem: 'holiday', withMedia: false })

    const result = await importPaths(sidecar)

    expect(result.issues).toEqual([
      expect.objectContaining({ severity: 'warning', reason: 'media file is missing beside the sidecar: holiday.mp4' }),
    ])
    expect(await readdir(state.libraryDir)).toEqual([])
  })

  it('refuses a bundle whose media name is already taken in the library', async () => {
    const sidecar = await stageBundle({ stem: 'holiday' })
    await writeFile(join(state.libraryDir, 'Holiday.mp4'), 'a different tape')

    const result = await importPaths(sidecar)

    expect(result.imported).toEqual([])
    expect(result.issues[0]).toMatchObject({ severity: 'error' })
    expect(await readFile(join(state.libraryDir, 'Holiday.mp4'), 'utf8'), 'the file there is untouched').toBe(
      'a different tape',
    )
  })

  it('explains the files in the selection that no sidecar accounted for', async () => {
    const sidecar = await stageBundle({ stem: 'holiday', thumbnailFilename: 'holiday.jpg' })
    const stray = join(sourceDir, 'notes.txt')
    await writeFile(stray, 'notes')

    const result = await importPaths(sidecar, join(sourceDir, 'holiday.mp4'), join(sourceDir, 'holiday.jpg'), stray)

    expect(result.imported).toHaveLength(1)
    expect(result.issues).toEqual([
      expect.objectContaining({
        path: stray,
        severity: 'warning',
        reason: 'TapeBox imports .json sidecars together with the media and image files they name.',
      }),
    ])
  })

  it('announces nothing when the whole selection was refused', async () => {
    const result = await importPaths(await stageBundle({ stem: 'holiday', withMedia: false }))

    expect(result.imported).toEqual([])
    expect(emit).not.toHaveBeenCalled()
    expect(log.info).toHaveBeenCalledWith('library:import', { imported: 0, issues: 1 })
  })
})
