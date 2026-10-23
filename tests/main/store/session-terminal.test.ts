import { mkdir, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Box, Tape } from '@shared/domain'

const testRoot = vi.hoisted(
  () => `${process.env.TEMP ?? process.env.TMPDIR ?? '/tmp'}/tapebox-session-terminal-${process.pid}`,
)
const record = vi.hoisted(() => vi.fn())
const catalogMutation = vi.hoisted(() => ({
  failRenamedOnce: false,
  failReorderOnce: false,
  failBoxReorderOnce: false,
  failOrdinaryWrites: 0,
  saved: null as (() => void) | null,
}))

vi.mock('@main/paths', () => ({ collectionCatalog: () => join(testRoot, 'catalog.json') }))
vi.mock('@main/store/config', () => ({ getLibraryDir: () => testRoot }))
vi.mock('@main/store/backupStore', () => ({ record }))
vi.mock('@main/store/catalog-codec', async (original) => {
  const actual = await original<typeof import('@main/store/catalog-codec')>()
  return { catalogCodec: vi.fn(actual.catalogCodec) }
})
import { catalogCodec } from '@main/store/catalog-codec'
vi.mock('@main/io/logger', () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))
vi.mock('@main/io/atomic-json', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@main/io/atomic-json')>()
  return {
    ...actual,
    writeManagedJsonBytes: vi.fn(async (...args: Parameters<typeof actual.writeManagedJsonBytes>) => {
      const value = JSON.parse(args[1].toString('utf8')) as { tapes?: Tape[]; boxes?: Box[] }
      if (catalogMutation.failRenamedOnce && value.tapes?.some((item) => item.name === 'Renamed')) {
        catalogMutation.failRenamedOnce = false
        throw new Error('catalog disk full')
      }
      if (catalogMutation.failReorderOnce && value.tapes?.some((item) => item.id === 'def1234567' && item.order === 0)) {
        catalogMutation.failReorderOnce = false
        throw new Error('catalog reorder disk full')
      }
      if (catalogMutation.failBoxReorderOnce && value.boxes?.some((item) => item.id === 'boxdef4567' && item.order === 0)) {
        catalogMutation.failBoxReorderOnce = false
        throw new Error('box reorder disk full')
      }
      if (catalogMutation.failOrdinaryWrites > 0) {
        catalogMutation.failOrdinaryWrites -= 1
        throw new Error('catalog disk full')
      }
      await actual.writeManagedJsonBytes(...args)
      catalogMutation.saved?.()
    }),
  }
})

import {
  loadSession,
  onCatalogSaveFailure,
  getBoxes,
  getTapes,
  removeTapes,
  removeBox,
  getTape,
  persistNow,
  upsertBox,
  upsertTape,
  renameTapeDurably,
  reorderTapesDurably,
  reorderBoxesDurably,
  bindSession,
} from '@main/store/session'

function tape(id = 'abc1234567', order = 0): Tape {
  return {
    id, sourceUrl: `https://example.test/watch/${id}`, state: 'downloaded',
    addedAtUtc: '2026-01-01T00:00:00.000Z', sourceId: id, extractor: 'test',
    title: 'Title', uploader: null, durationSeconds: 1, chapterCount: 0,
    probedAtUtc: '2026-01-01T00:00:00.000Z', filename: `${id}.mp4`,
    sidecarFilename: `${id}.json`, thumbnailFilename: null, downloadStartedAtUtc: null,
    downloadedAtUtc: '2026-01-01T00:00:00.000Z', name: 'Take', renamedAtUtc: null,
    archivedAtUtc: null, boxId: null, order, pausedAtUtc: null, failedAtUtc: null, failureCode: null, lastError: null,
  }
}

beforeEach(async () => {
  record.mockReset()
  catalogMutation.failRenamedOnce = false
  catalogMutation.failReorderOnce = false
  catalogMutation.failBoxReorderOnce = false
  catalogMutation.failOrdinaryWrites = 0
  catalogMutation.saved = null
  await mkdir(testRoot, { recursive: true })
})

afterEach(async () => {
  await rm(testRoot, { recursive: true, force: true })
})

describe('catalog persistence', () => {
  it('does not publish an in-memory rename until catalog.json names it', async () => {
    await loadSession()
    const original = tape()
    const updated = { ...original, name: 'Renamed', filename: 'Renamed.mp4' }
    upsertTape(original)
    await persistNow()

    const committing = renameTapeDurably(updated)
    expect(getTape(updated.id)?.name).toBe('Take')
    await committing

    const catalog = JSON.parse(await readFile(join(testRoot, 'catalog.json'), 'utf8')) as { tapes: Tape[] }
    expect(catalog.tapes).toEqual([updated])
    expect(getTape(updated.id)).toEqual(updated)
  })

  it('reserves the durable transaction between ordinary writes and rolls it back in place', async () => {
    await loadSession()
    const original = tape()
    const updated = { ...original, name: 'Renamed', filename: 'Renamed.mp4' }
    const box = { id: 'box1234567', name: 'Keepers', order: 0 }
    upsertTape(original)

    const before = persistNow()
    catalogMutation.failRenamedOnce = true
    const durableResult = renameTapeDurably(updated).then(
      () => null,
      (error: unknown) => error,
    )
    upsertBox(box)
    const after = persistNow()

    await before
    expect(await durableResult).toMatchObject({ message: 'catalog disk full' })
    await after

    const catalog = JSON.parse(await readFile(join(testRoot, 'catalog.json'), 'utf8')) as {
      tapes: Tape[]
      boxes: typeof box[]
    }
    expect(catalog).toEqual({ formatVersion: 1, tapes: [original], boxes: [box] })
  })

  it('publishes a reorder only after the complete catalog order is durable', async () => {
    await loadSession()
    const first = tape('abc1234567', 0)
    const second = tape('def1234567', 1)
    upsertTape(first)
    upsertTape(second)
    await persistNow()

    catalogMutation.failReorderOnce = true
    await expect(reorderTapesDurably([second.id, first.id])).rejects.toThrow('catalog reorder disk full')
    expect(getTape(first.id)?.order).toBe(0)
    expect(getTape(second.id)?.order).toBe(1)

    const unchanged = JSON.parse(await readFile(join(testRoot, 'catalog.json'), 'utf8')) as { tapes: Tape[] }
    expect(unchanged.tapes.map((item) => [item.id, item.order])).toEqual([
      [first.id, 0],
      [second.id, 1],
    ])

    await reorderTapesDurably([second.id, first.id])
    expect(getTape(first.id)?.order).toBe(1)
    expect(getTape(second.id)?.order).toBe(0)
  })

  it('keeps box ordering unchanged when its durable catalog write fails', async () => {
    await loadSession()
    const first = { id: 'boxabc4567', name: 'First', order: 0 }
    const second = { id: 'boxdef4567', name: 'Second', order: 1 }
    upsertBox(first)
    upsertBox(second)
    await persistNow()

    catalogMutation.failBoxReorderOnce = true
    await expect(reorderBoxesDurably([second.id, first.id])).rejects.toThrow('box reorder disk full')
    expect(getBoxes().map((box) => [box.id, box.order])).toEqual([
      [first.id, 0],
      [second.id, 1],
    ])

    await reorderBoxesDurably([second.id, first.id])
    expect(getBoxes().map((box) => [box.id, box.order])).toEqual([
      [first.id, 1],
      [second.id, 0],
    ])
  })

  it('writes a download in flight as its queued self, so queue steps add no catalog versions', async () => {
    await loadSession()
    record.mockClear()
    const queued: Tape = {
      ...tape('fly1234567'), state: 'queued', sourceId: null, extractor: null, title: null,
      probedAtUtc: null, filename: null, sidecarFilename: null, downloadedAtUtc: null, name: null,
    }
    const catalogPath = join(testRoot, 'catalog.json')
    const writes = (): number => record.mock.calls.filter(([path]) => path === catalogPath).length

    upsertTape(queued)
    await persistNow()
    expect(writes()).toBe(1)

    upsertTape({ ...queued, state: 'probing' })
    await persistNow()
    expect(writes()).toBe(1)

    const probed = { ...queued, state: 'ready' as const, sourceId: 'vid', extractor: 'test', title: 'Probed', probedAtUtc: '2026-01-02T00:00:00.000Z' }
    upsertTape(probed)
    await persistNow()
    expect(writes()).toBe(2)

    upsertTape({ ...probed, state: 'downloading', downloadStartedAtUtc: '2026-01-02T00:00:01.000Z' })
    await persistNow()
    expect(writes()).toBe(2)

    const onDisk = JSON.parse(await readFile(catalogPath, 'utf8')) as { tapes: Tape[] }
    expect(onDisk.tapes[0]).toMatchObject({ state: 'queued', title: 'Probed', downloadStartedAtUtc: null })

    upsertTape({ ...probed, state: 'downloaded', filename: 'fly1234567.mp4', downloadedAtUtc: '2026-01-02T00:01:00.000Z' })
    await persistNow()
    expect(writes()).toBe(3)
  })

  it('keeps a change whose save failed, reports the failure once, and writes it on the retry', async () => {
    await loadSession()
    const failures = vi.fn()
    onCatalogSaveFailure(failures)
    const finished = tape('fin1234567')
    upsertTape(finished)

    catalogMutation.failOrdinaryWrites = 2
    await expect(persistNow()).resolves.toBe(false)
    await expect(persistNow()).resolves.toBe(false)
    expect(failures).toHaveBeenCalledOnce()
    expect(getTape(finished.id)).toEqual(finished)

    await expect(persistNow()).resolves.toBe(true)
    const onDisk = JSON.parse(await readFile(join(testRoot, 'catalog.json'), 'utf8')) as { tapes: Tape[] }
    expect(onDisk.tapes).toEqual([finished])
    onCatalogSaveFailure(() => {})
  })

  it('retries a failed save on its own schedule, apart from the operation that made the change', async () => {
    await loadSession()
    onCatalogSaveFailure(() => {})
    const finished = tape('ret1234567')
    const saved = new Promise<void>((resolve) => { catalogMutation.saved = resolve })
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      upsertTape(finished)
      catalogMutation.failOrdinaryWrites = 1
      // The caller's own wait ends with the failure; nothing it later cancels reaches the retry.
      await expect(persistNow()).resolves.toBe(false)
      await vi.advanceTimersByTimeAsync(30_000)
    } finally { vi.useRealTimers() }
    await saved
    const onDisk = JSON.parse(await readFile(join(testRoot, 'catalog.json'), 'utf8')) as { tapes: Tape[] }
    expect(onDisk.tapes).toEqual([finished])
  })

  it('leaves a quit-time save failure to the quit to tell, and does not report it again afterwards', async () => {
    await loadSession()
    const failures = vi.fn()
    onCatalogSaveFailure(failures)
    upsertTape(tape('qui1234567'))

    catalogMutation.failOrdinaryWrites = 2
    await expect(persistNow({ quitting: true })).resolves.toBe(false)
    // The quit's dialog told the user; a later autosave failure does not repeat it.
    await expect(persistNow()).resolves.toBe(false)
    expect(failures).not.toHaveBeenCalled()

    await expect(persistNow()).resolves.toBe(true)
    onCatalogSaveFailure(() => {})
  })
})


describe('live catalog admission and derived lookup indexes', () => {
  it('rejects invalid rows, unknown boxes, and portable filename aliases before changing the cache', async () => {
    await loadSession()
    const original = tape()
    upsertTape(original)
    expect(() => upsertTape({ ...original, sourceUrl: 'file:///private' })).toThrow()
    expect(() => upsertTape({ ...original, boxId: 'missingbox' })).toThrow('Unknown box')
    expect(() => upsertTape({ ...tape('def1234567'), filename: original.filename!.toUpperCase() })).toThrow('already in use')
    expect(() => upsertTape({ ...original, sidecarFilename: original.filename })).toThrow('already in use')
    expect(getTape(original.id)).toEqual(original)
    expect(getTapes()).toHaveLength(1)
    await expect(persistNow()).resolves.toBe(true)
  })

  it('updates filename ownership after durable rename and rebuilds positions after removal and rebind', async () => {
    await loadSession()
    const first = tape()
    const second = tape('def1234567')
    upsertTape(first)
    upsertTape(second)
    await expect(renameTapeDurably({ ...first, filename: second.filename })).rejects.toThrow('already in use')
    await renameTapeDurably({ ...first, filename: 'Renamed.mp4' })
    upsertTape({ ...second, filename: first.filename })
    expect(() => upsertTape({ ...second, filename: 'RENAMED.MP4' })).toThrow('already in use')
    removeTapes([first.id])
    upsertTape({ ...second, title: 'After removal', filename: 'Renamed.mp4' })
    expect(getTape(first.id)).toBeUndefined()
    expect(getTape(second.id)?.title).toBe('After removal')
    await persistNow()
    await loadSession()
    upsertTape({ ...getTape(second.id)!, title: 'After rebind' })
    expect(getTape(second.id)?.title).toBe('After rebind')
    expect(getTapes()).toHaveLength(1)
    await persistNow()
  })

  it('admits unique boxes and refuses deletion while a tape still references one', async () => {
    await loadSession()
    const box = { id: 'box1234567', name: 'Saved', order: 0 }
    upsertBox(box)
    expect(() => upsertBox({ ...box, id: 'bad' })).toThrow()
    expect(() => upsertBox({ ...box, id: 'box7654321', name: ' saved ' })).toThrow('unique')
    const archived = { ...tape(), archivedAtUtc: '2026-10-23T00:00:00.000Z', boxId: box.id }
    upsertTape(archived)
    expect(() => removeBox(box.id)).toThrow('still referenced')
    upsertTape({ ...archived, boxId: null })
    removeBox(box.id)
    upsertBox({ id: 'box7654321', name: box.name, order: 0 })
    expect(getBoxes()).toEqual([{ id: 'box7654321', name: box.name, order: 0 }])
    await persistNow()
  })
})


describe('catalog codec publication', () => {
  it('keeps later mutations dirty when an earlier generation settles', async () => {
    await loadSession()
    const original = tape()
    upsertTape(original)
    catalogMutation.saved = () => {
      catalogMutation.saved = null
      upsertTape({ ...original, title: 'Changed during publication' })
    }
    await persistNow()
    vi.mocked(catalogCodec).mockClear()
    await persistNow()
    expect(catalogCodec).toHaveBeenCalledOnce()
    const stored = JSON.parse(await readFile(join(testRoot, 'catalog.json'), 'utf8'))
    expect(stored.tapes[0].title).toBe('Changed during publication')
    vi.mocked(catalogCodec).mockClear()
    await persistNow({ quitting: true })
    expect(catalogCodec).not.toHaveBeenCalled()
  })

  it('keeps a committed rename dirty for metadata changed during publication', async () => {
    await loadSession()
    const original = tape()
    upsertTape(original)
    await persistNow()
    catalogMutation.saved = () => {
      catalogMutation.saved = null
      upsertTape({ ...original, title: 'New metadata' })
    }
    await renameTapeDurably({ ...original, name: 'Renamed', filename: 'Renamed.mp4' })
    await persistNow()
    const stored = JSON.parse(await readFile(join(testRoot, 'catalog.json'), 'utf8'))
    expect(stored.tapes[0]).toMatchObject({ title: 'New metadata', filename: 'Renamed.mp4' })
  })

  it('does not encode transient-only transitions or a settled durable rename again', async () => {
    await loadSession()
    const original = { ...tape(), state: 'queued' as const, downloadStartedAtUtc: null }
    upsertTape(original)
    await persistNow()
    vi.mocked(catalogCodec).mockClear()
    upsertTape({ ...original, state: 'downloading', downloadStartedAtUtc: '2026-01-02T00:00:00.000Z' })
    await persistNow()
    expect(catalogCodec).not.toHaveBeenCalled()
    await renameTapeDurably({ ...original, name: 'Renamed', filename: 'Renamed.mp4' })
    vi.mocked(catalogCodec).mockClear()
    await persistNow({ quitting: true })
    expect(catalogCodec).not.toHaveBeenCalled()
  })

  it('does not carry a clean generation into a newly bound collection', async () => {
    await loadSession()
    upsertTape(tape())
    await persistNow()
    const target = join(testRoot, 'other.json')
    bindSession(target, { tapes: [], boxes: [] })
    vi.mocked(catalogCodec).mockClear()
    await persistNow()
    expect(catalogCodec).toHaveBeenCalledOnce()
    expect(JSON.parse(await readFile(target, 'utf8')).tapes).toEqual([])
  })

  it('encodes outside main and suppresses a redundant save after loading the same catalog', async () => {
    await loadSession()
    upsertTape(tape())
    const stringify = JSON.stringify
    const mainEncoding = vi.spyOn(JSON, 'stringify').mockImplementation((value, ...args) => {
      if (value && typeof value === 'object' && 'tapes' in value && 'boxes' in value) throw new Error('main-thread catalog encoding')
      return stringify(value, ...args)
    })
    try {
      await expect(persistNow()).resolves.toBe(true)
    } finally { mainEncoding.mockRestore() }
    await loadSession()
    record.mockClear()
    vi.mocked(catalogCodec).mockClear()
    await expect(persistNow()).resolves.toBe(true)
    expect(record).not.toHaveBeenCalled()
    expect(catalogCodec).not.toHaveBeenCalled()
  })
})
