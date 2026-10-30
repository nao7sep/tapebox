import { librarySourceIndex } from '@shared/source-identity'
import type { SourceRef } from '@shared/source-identity'
vi.mock('@main/ipc/trust', () => ({ isTrustedApplicationSender: () => true }))
import { unwrapIpcReply, type IpcReply } from '@shared/ipc-reply'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TAPE_FILE, type Tape } from '@shared/domain'
import { compareInbox } from '@shared/order'
import type { Message } from '@shared/i18n/translate'
import { inEnglish } from '../../helpers/i18n'

// Importing a bundle someone exported: the sidecar names its media and poster,
// and this boundary decides what comes into the library, what is refused and
// what the user is told about the rest of their selection. Real files and real
// copies throughout; only the catalogue, the log and the event bus are stood in
// for, so an import that reports success has really landed on disk. Each
// imported tape gets its own folder, named by its id, under the library's inbox/.
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
  sourceOwner: (ref: SourceRef, exceptId?: string) => librarySourceIndex(state.tapes, exceptId).find(ref),
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
vi.mock('@main/services/ytdlp', () => ({ downloadThumbnail: vi.fn(), probe: vi.fn() }))
vi.mock('@main/services/ffmpeg', () => ({ saveThumbnailJpeg: vi.fn() }))
vi.mock('@main/io/logger', () => ({ log }))
vi.mock('@main/ipc/events', () => ({ emit }))

const { registerLibraryHandlers } = await import('@main/ipc/library')
const { withLibraryMove } = await import('@main/library-writes')

let root: string
let sourceDir: string

/** An Inbox tape's own folder inside the library. */
function folder(id: string): string {
  return join(state.libraryDir, 'inbox', id)
}

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
      ? { formatVersion: 1 }
      : {
          formatVersion: 1,
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
    name: null, renamedAtUtc: null, addedIndex: 0, shelved: false, boxId: null, order: 0,
    pausedAtUtc: null, failedAtUtc: null, failureCode: null, lastError: null,
    ...overrides,
  }
}

// Each issue's reason as an English interface shows it, so the assertions read
// the words a user sees.
async function importPaths(...paths: string[]): Promise<ImportResult> {
  const result = await handlers.get('library:import')!({ paths }) as {
    imported: Tape[]
    issues: Array<{ path: string; reason: Message; severity: string }>
  }
  return { ...result, issues: result.issues.map((issue) => ({ ...issue, reason: inEnglish(issue.reason)! })) }
}

beforeEach(async () => {
  handlers.clear()
  vi.clearAllMocks()
  root = await mkdtemp(join(tmpdir(), 'tapebox-import-'))
  sourceDir = join(root, 'source')
  state.libraryDir = join(root, 'library')
  state.tapes = []
  await mkdir(sourceDir)
  // A fresh collection has no inbox/ folder yet; import makes it.
  await mkdir(state.libraryDir, { recursive: true })
  registerLibraryHandlers()
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

describe('importing a bundle', () => {
  it('copies the media, sidecar and poster in, and sorts the tape into the inbox by its own times', async () => {
    const sidecar = await stageBundle({ stem: 'holiday', thumbnailFilename: 'holiday.jpg' })
    state.tapes = [makeTape({ id: 'already-here', addedAtUtc: '2025-12-01T00:00:00.000Z' })]

    const result = await importPaths(sidecar, join(sourceDir, 'holiday.mp4'), join(sourceDir, 'holiday.jpg'))

    expect(result.issues).toEqual([])
    expect(result.imported).toHaveLength(1)
    const [tape] = result.imported
    expect(tape).toMatchObject({
      sourceUrl: 'https://example.test/holiday',
      filename: 'holiday.mp4',
      sidecarFilename: 'holiday.json',
      thumbnailFilename: 'holiday.jpg',
      shelved: false,
      addedAtUtc: '2026-01-01T00:00:00.000Z',
      addedIndex: 0,
    })
    expect([...state.tapes].sort(compareInbox).map((entry) => entry.id), 'added later, it sorts above the older tape').toEqual([tape.id, 'already-here'])
    expect(await readdir(join(state.libraryDir, 'inbox')), 'the bundle lands in its own folder').toEqual([tape.id])
    expect((await readdir(folder(tape.id))).sort()).toEqual(['holiday.jpg', 'holiday.json', 'holiday.mp4'])
    expect(await readFile(join(folder(tape.id), 'holiday.mp4'), 'utf8')).toBe('video for holiday')
    // The tape's own file holds the bundle's catalog fields; the library sidecar keeps only the media facts.
    const kept = JSON.parse(await readFile(join(folder(tape.id), 'holiday.json'), 'utf8'))
    expect(kept.tapebox).toEqual({ media: null })
    expect(state.tapes.map((entry) => entry.id)).toContain(tape.id)
    expect(emit).toHaveBeenCalledExactlyOnceWith('tapes:added', result.imported)
    // The imported rows are durable before they are announced.
    expect(persistNow).toHaveBeenCalled()
    expect(persistNow.mock.invocationCallOrder.at(-1)!).toBeLessThan(emit.mock.invocationCallOrder[0]!)
  })

  it('imports a bundle whose file names another tape also uses, into its own folder', async () => {
    state.tapes = [makeTape({ id: 'has-trip', filename: 'trip.mp4', sidecarFilename: 'trip.json', thumbnailFilename: 'poster.jpg' })]
    await mkdir(folder('has-trip'), { recursive: true })
    await writeFile(join(folder('has-trip'), 'trip.mp4'), 'the other tape')
    const sidecar = await stageBundle({ stem: 'trip', sourceUrl: 'https://example.test/other-trip', thumbnailFilename: 'poster.jpg' })

    const result = await importPaths(sidecar, join(sourceDir, 'trip.mp4'), join(sourceDir, 'poster.jpg'))

    expect(result.issues).toEqual([])
    const [tape] = result.imported
    expect(tape).toMatchObject({ filename: 'trip.mp4', sidecarFilename: 'trip.json', thumbnailFilename: 'poster.jpg' })
    expect((await readdir(folder(tape.id))).sort()).toEqual(['poster.jpg', 'trip.json', 'trip.mp4'])
    expect(await readFile(join(folder('has-trip'), 'trip.mp4'), 'utf8'), 'the other tape is untouched').toBe('the other tape')
  })

  it('waits for a library move to end before copying anything', async () => {
    const sidecar = await stageBundle({ stem: 'late' })
    let finishMove!: () => void
    const moving = withLibraryMove(() => new Promise<void>((resolve) => { finishMove = resolve }))

    const importing = importPaths(sidecar)
    await new Promise((resolve) => setImmediate(resolve))
    expect(await readdir(state.libraryDir)).toEqual([])

    finishMove()
    await moving
    const result = await importing
    expect(result.imported).toHaveLength(1)
    expect((await readdir(folder(result.imported[0].id))).sort()).toEqual(['late.json', 'late.mp4'])
  })

  it('reports a bundle of a video already in the library under a URL with tracking parameters', async () => {
    state.tapes = [makeTape({ id: 'already-in', sourceUrl: 'https://www.youtube.com/watch?v=X' })]
    const sidecar = await stageBundle({ stem: 'shared', sourceUrl: 'https://www.youtube.com/watch?v=X&si=abc' })

    const result = await importPaths(sidecar)

    expect(result.imported).toEqual([])
    expect(result.issues).toEqual([expect.objectContaining({ path: sidecar, reason: 'Already in the library.' })])
    expect(await readdir(state.libraryDir)).toEqual([])
  })

  it('names the library copies after the media file, not after the sidecar', async () => {
    const sidecar = await stageBundle({ stem: 'holiday', sidecarName: 'renamed-by-hand.json' })

    const result = await importPaths(sidecar)

    expect(result.imported[0]).toMatchObject({ filename: 'holiday.mp4', sidecarFilename: 'holiday.json' })
    expect((await readdir(folder(result.imported[0].id))).sort()).toEqual(['holiday.json', 'holiday.mp4'])
  })

  it('names the copies after the tape id when the media stem would make the sidecar tape.json', async () => {
    const sidecar = await stageBundle({ stem: 'tape', sidecarName: 'bundle.json' })

    const result = await importPaths(sidecar)

    expect(result.issues).toEqual([])
    const [tape] = result.imported
    expect(tape).toMatchObject({ filename: `${tape.id}.mp4`, sidecarFilename: `${tape.id}.json` })
    expect(TAPE_FILE).toBe('tape.json')
    expect((await readdir(folder(tape.id))).sort(), 'only the tape\'s own file is called tape.json').toEqual([`${tape.id}.json`, `${tape.id}.mp4`])
  })

  it('keeps a batch in the order it was chosen, even when one of them is refused', async () => {
    const first = await stageBundle({ stem: 'first' })
    const broken = await stageBundle({ stem: 'broken', withMedia: false })
    const last = await stageBundle({ stem: 'last' })

    const result = await importPaths(first, broken, last)

    expect(result.imported.map((tape) => tape.filename)).toEqual(['first.mp4', 'last.mp4'])
    expect(result.imported.map((tape) => tape.addedIndex)).toEqual([0, 1])
    expect([...result.imported].sort(compareInbox).map((tape) => tape.filename), 'the first chosen sorts on top').toEqual(['first.mp4', 'last.mp4'])
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
    expect(await readFile(join(folder(result.imported[0].id), 'inplace.mp4'), 'utf8')).toBe('video for inplace')
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
      expect.objectContaining({ severity: 'information', reason: 'Already in the library.' }),
    ])
    expect(await readdir(state.libraryDir)).toEqual([])
  })

  it('says which media file is missing beside its sidecar', async () => {
    const sidecar = await stageBundle({ stem: 'holiday', withMedia: false })

    const result = await importPaths(sidecar)

    expect(result.issues).toEqual([
      expect.objectContaining({ severity: 'warning', reason: 'The media file holiday.mp4 is missing beside the sidecar.' }),
    ])
    expect(await readdir(state.libraryDir)).toEqual([])
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
