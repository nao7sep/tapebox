import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ShelfSchema, TapeFileSchema, type Tape } from '@shared/domain'

// The collection on disk: inbox/<id>/ and shelf/<id>/ tape folders, each with its
// own tape.json, and shelf.json for the Shelf's boxes and order. Real temp
// folders throughout, so a deleted shelf.json, a move stopped halfway and a
// damaged tape file are the real thing.

const state = vi.hoisted(() => ({ dir: '', failWrite: null as null | ((path: string) => boolean), failRename: false }))
vi.mock('@main/store/config', () => ({ getCollectionDir: () => state.dir }))
vi.mock('@main/store/backupStore', () => ({ record: vi.fn() }))
vi.mock('@main/io/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }))
vi.mock('@main/io/atomic-json', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@main/io/atomic-json')>()
  return {
    ...actual,
    writeManagedJsonBytes: async (...args: Parameters<typeof actual.writeManagedJsonBytes>) => {
      if (state.failWrite?.(args[0])) throw new Error('disk full')
      return actual.writeManagedJsonBytes(...args)
    },
  }
})
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return {
    ...actual,
    rename: (async (...args: Parameters<typeof actual.rename>) => {
      // Only a tape folder's move; atomic file writes rename their .tmp files.
      if (state.failRename && !String(args[0]).endsWith('.tmp')) throw Object.assign(new Error('EBUSY: folder in use'), { code: 'EBUSY' })
      return actual.rename(...args)
    }) as typeof actual.rename,
  }
})

const session = await import('@main/store/session')
const { encodeShelf, encodeTapeFile, readCollection } = await import('@main/store/collection-files')

const BOX = 'BoxA000001'

function tape(id: string, overrides: Partial<Tape> = {}): Tape {
  return {
    id, sourceUrl: `https://example.test/${id}`, state: 'downloaded', addedAtUtc: '2026-01-01T00:00:00.000Z',
    addedIndex: 0, sourceId: id, extractor: 'test', title: id, uploader: null, durationSeconds: 1,
    chapterCount: 0, probedAtUtc: null, filename: `${id}.mp4`,
    sidecarFilename: `${id}.json`, thumbnailFilename: null, downloadStartedAtUtc: null,
    downloadedAtUtc: '2026-01-01T00:00:00.000Z', name: null, renamedAtUtc: null,
    shelved: false, boxId: null, order: 0, pausedAtUtc: null, failedAtUtc: null, failureCode: null, lastError: null,
    ...overrides,
  }
}

const fixtureTapes = () => [
  tape('Inbox00001', { addedIndex: 1 }),
  tape('Inbox00002'),
  tape('Boxed00001', { shelved: true, boxId: BOX }),
  tape('Loose00001', { shelved: true }),
  tape('Queued0001', { state: 'queued', filename: null, sidecarFilename: null, downloadedAtUtc: null }),
]

/** Seed the collection on disk: each tape's folder with its media and tape.json, then shelf.json. */
async function writeCollection(tapes: Tape[]): Promise<void> {
  for (const item of tapes) {
    const folder = join(state.dir, item.shelved ? 'shelf' : 'inbox', item.id)
    await mkdir(folder, { recursive: true })
    await writeFile(join(folder, 'tape.json'), encodeTapeFile(item))
    if (item.filename !== null) await writeFile(join(folder, item.filename), 'media')
  }
  await writeFile(join(state.dir, 'shelf.json'), encodeShelf({ tapes, boxes: [{ id: BOX, name: 'Box', order: 0 }] }))
}

const where = (tapes: readonly Tape[]) => Object.fromEntries(tapes.map((item) => [item.id, item.shelved ? item.boxId ?? 'loose' : 'inbox']))
const shelfOnDisk = async () => ShelfSchema.parse(JSON.parse(await readFile(join(state.dir, 'shelf.json'), 'utf8')))
async function reload(): Promise<Tape[]> {
  const read = await readCollection(state.dir)
  return read.session.tapes
}

beforeEach(async () => {
  state.dir = await mkdtemp(join(tmpdir(), 'tapebox-collection-'))
  state.failWrite = null
  state.failRename = false
})

afterEach(async () => {
  await rm(state.dir, { recursive: true, force: true })
})

describe('tapes without shelf.json', () => {
  it('loses no tape when shelf.json is deleted, shelved ones becoming loose tapes', async () => {
    await writeCollection(fixtureTapes())
    await session.loadSession()
    await rm(join(state.dir, 'shelf.json'))

    await expect(session.loadSession()).resolves.toMatchObject({ status: 'loaded', tapeCount: 5 })

    expect(where(session.getTapes())).toEqual({
      Inbox00001: 'inbox', Inbox00002: 'inbox', Queued0001: 'inbox', Boxed00001: 'loose', Loose00001: 'loose',
    })
    expect(session.getBoxes()).toEqual([])
    expect(await shelfOnDisk()).toEqual({ boxes: [], loose: ['Boxed00001', 'Loose00001'] })
  })

  it('puts a shelf/ folder shelf.json does not place on top of Loose tapes, newest first, and drops ids with no folder', async () => {
    await session.loadSession()
    for (const item of [
      tape('Listed0001', { shelved: true }),
      tape('Older00001', { shelved: true, addedAtUtc: '2026-03-01T00:00:00.000Z' }),
      tape('Newer00001', { shelved: true, addedAtUtc: '2026-04-01T00:00:00.000Z' }),
      tape('InInbox001'),
    ]) session.upsertTape(item)
    await session.persistNow()
    await writeFile(join(state.dir, 'shelf.json'), JSON.stringify({
      formatVersion: 1,
      boxes: [{ id: BOX, name: 'Box', tapeIds: ['Missing001', 'InInbox001'] }],
      loose: ['Missing002', 'Listed0001'],
    }))

    const tapes = await reload()

    const loose = tapes.filter((item) => item.shelved && item.boxId === null).sort((a, b) => a.order - b.order)
    expect(loose.map((item) => item.id)).toEqual(['Newer00001', 'Older00001', 'Listed0001'])
    // A tape in inbox/ stays in the Inbox whatever shelf.json lists.
    expect(where(tapes)['InInbox001']).toBe('inbox')
    expect(tapes.filter((item) => item.boxId === BOX)).toEqual([])
  })
})

describe('moving between the Inbox and the Shelf', () => {
  it('shelves by moving the folder, then adding it on top of Loose tapes', async () => {
    await session.loadSession()
    session.upsertTape(tape('Mover00001'))
    await session.persistNow()

    const moved = await session.shelveTapes(['Mover00001'])

    expect(moved).toMatchObject([{ id: 'Mover00001', shelved: true, boxId: null }])
    expect(await readdir(join(state.dir, 'inbox'))).toEqual([])
    expect((await readdir(join(state.dir, 'shelf', 'Mover00001'))).sort()).toEqual(['tape.json'])
    expect((await shelfOnDisk()).loose).toEqual(['Mover00001'])
  })

  it('keeps a tape shelved when shelf.json is not written after its folder moved', async () => {
    await session.loadSession()
    session.upsertTape(tape('Mover00001'))
    await session.persistNow()
    state.failWrite = (path) => path.endsWith('shelf.json')

    await session.shelveTapes(['Mover00001'])

    // As a crash right after the folder move would leave it.
    expect(where(await reload())).toEqual({ Mover00001: 'loose' })
  })

  it('takes a tape back to the Inbox by dropping it from shelf.json, then moving its folder', async () => {
    await session.loadSession()
    session.upsertTape(tape('Mover00001', { shelved: true, boxId: null }))
    await session.persistNow()

    await session.unshelveTapes(['Mover00001'])

    expect(where(session.getTapes())).toEqual({ Mover00001: 'inbox' })
    expect(await readdir(join(state.dir, 'shelf'))).toEqual([])
    expect((await shelfOnDisk()).loose).toEqual([])
    expect(where(await reload())).toEqual({ Mover00001: 'inbox' })
  })

  it('keeps a tape on the Shelf when its folder cannot move after shelf.json dropped it', async () => {
    await session.loadSession()
    session.upsertTape(tape('Mover00001', { shelved: true, boxId: null }))
    await session.persistNow()
    state.failRename = true

    await expect(session.unshelveTapes(['Mover00001'])).rejects.toThrow('EBUSY')

    // shelf.json no longer places it; its folder is still in shelf/, so it shows
    // on top of Loose tapes, now and after a restart.
    expect((await shelfOnDisk()).loose).toEqual([])
    expect(where(session.getTapes())).toEqual({ Mover00001: 'loose' })
    expect(where(await reload())).toEqual({ Mover00001: 'loose' })
  })
})

describe('a damaged tape file', () => {
  it('names the file and leaves it exactly as it is', async () => {
    await writeCollection(fixtureTapes())
    await session.loadSession()
    const broken = join(state.dir, 'inbox', 'Inbox00001', 'tape.json')
    await writeFile(broken, '{ not json')
    const newer = join(state.dir, 'shelf', 'Boxed00001', 'tape.json')
    const newerBytes = JSON.stringify({ formatVersion: 99, id: 'Boxed00001' })
    await writeFile(newer, newerBytes)

    const result = await session.loadSession()

    expect(result.damaged.map((item) => ({ id: item.id, path: item.path }))).toEqual([
      { id: 'Inbox00001', path: broken },
      { id: 'Boxed00001', path: newer },
    ])
    expect(session.getTapes().map((item) => item.id)).not.toContain('Inbox00001')
    session.upsertTape(tape('Another001'))
    await session.persistNow()
    expect(await readFile(broken, 'utf8')).toBe('{ not json')
    expect(await readFile(newer, 'utf8')).toBe(newerBytes)
  })

  it('names a tape that is in both the Inbox and the Shelf', async () => {
    await session.loadSession()
    session.upsertTape(tape('Twice00001'))
    await session.persistNow()
    await mkdir(join(state.dir, 'shelf', 'Twice00001'), { recursive: true })
    await writeFile(join(state.dir, 'shelf', 'Twice00001', 'tape.json'), await readFile(join(state.dir, 'inbox', 'Twice00001', 'tape.json')))

    const read = await readCollection(state.dir)

    expect(read.damaged.map((item) => item.path)).toEqual([join(state.dir, 'shelf', 'Twice00001', 'tape.json')])
  })

  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)('names a tape file that cannot be opened', async () => {
    await mkdir(join(state.dir, 'inbox', 'Locked0001'), { recursive: true })
    const path = join(state.dir, 'inbox', 'Locked0001', 'tape.json')
    await writeFile(path, '{}')
    await chmod(path, 0o000)
    try {
      const read = await readCollection(state.dir)
      expect(read.damaged).toMatchObject([{ id: 'Locked0001', path }])
    } finally {
      await chmod(path, 0o600)
    }
  })

  it('ignores a folder that holds no tape file', async () => {
    await mkdir(join(state.dir, 'inbox', 'NoTapeJson'), { recursive: true })
    await writeFile(join(state.dir, 'inbox', 'NoTapeJson', 'clip.mp4'), 'x')

    const read = await readCollection(state.dir)

    expect([read.session.tapes, read.damaged]).toEqual([[], []])
  })
})

describe('a queued tape', () => {
  it('gets its Inbox folder and tape file with its first save', async () => {
    await session.loadSession()
    session.upsertTape(tape('Queued0002', { state: 'queued', filename: null, sidecarFilename: null }))

    await session.persistNow()

    expect(TapeFileSchema.parse(JSON.parse(await readFile(join(state.dir, 'inbox', 'Queued0002', 'tape.json'), 'utf8'))).state).toBe('queued')
  })
})
