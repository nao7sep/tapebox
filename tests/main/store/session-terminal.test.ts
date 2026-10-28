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
  filenameOwner,
  stemOwner,
  sourceOwner,
  onCatalogSaveFailure,
  getBoxes,
  getTapes,
  removeTapes,
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

/** The durable rename of `renamed`'s rename fields onto its row. */
const rename = (renamed: Tape) => renameTapeDurably(renamed.id, {
  filename: renamed.filename, sidecarFilename: renamed.sidecarFilename, thumbnailFilename: renamed.thumbnailFilename,
  name: renamed.name, renamedAtUtc: renamed.renamedAtUtc,
})

describe('catalog persistence', () => {
  it('keeps ownership current through updates, durable rename, removal and collection binding', async () => {
    await loadSession()
    const first = { ...tape(), filename: 'First.mp4' }
    upsertTape(first)
    expect(filenameOwner('FIRST.MP4')).toBe(first.id)
    expect(stemOwner('First')).toBe(first.id)
    expect(filenameOwner(`${first.id}.part`)).toBe(first.id)
    expect(sourceOwner({ url: first.sourceUrl }, first.id)).toBeUndefined()
    const changed = { ...first, sourceUrl: 'https://example.test/new', sourceId: 'new' }
    upsertTape(changed)
    expect(sourceOwner({ url: first.sourceUrl })).toBeUndefined()
    expect(sourceOwner({ url: changed.sourceUrl })).toBe(first.id)
    const renaming = rename({ ...changed, filename: 'Next.mp4' })
    expect(filenameOwner('First.mp4')).toBe(first.id)
    await renaming
    expect(filenameOwner('First.mp4')).toBeUndefined()
    expect(filenameOwner('Next.mp4')).toBe(first.id)
    removeTapes([first.id])
    expect(filenameOwner('Next.mp4')).toBeUndefined()
    expect(stemOwner(first.id)).toBeUndefined()
    expect(sourceOwner({ url: changed.sourceUrl })).toBeUndefined()
    await persistNow()
    bindSession(join(testRoot, 'other.json'), { tapes: [first], boxes: [] })
    expect(filenameOwner('First.mp4')).toBe(first.id)
    bindSession(join(testRoot, 'empty.json'), { tapes: [], boxes: [] })
    expect(filenameOwner('First.mp4')).toBeUndefined()
    expect(sourceOwner({ url: first.sourceUrl })).toBeUndefined()
  })

  it('does not publish an in-memory rename until catalog.json names it', async () => {
    await loadSession()
    const original = tape()
    const updated = { ...original, name: 'Renamed', filename: 'Renamed.mp4' }
    upsertTape(original)
    await persistNow()

    const committing = rename(updated)
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
    const durableResult = rename(updated).then(
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

  it('keeps a reorder whose save failed, as any library edit, and writes it on the retry', async () => {
    await loadSession()
    const failures = vi.fn()
    onCatalogSaveFailure(failures)
    const first = tape('abc1234567', 0)
    const second = tape('def1234567', 1)
    const firstBox = { id: 'boxabc4567', name: 'First', order: 0 }
    const secondBox = { id: 'boxdef4567', name: 'Second', order: 1 }
    upsertTape(first)
    upsertTape(second)
    upsertBox(firstBox)
    upsertBox(secondBox)
    await persistNow()

    catalogMutation.failReorderOnce = true
    await reorderTapesDurably([second.id, first.id])
    catalogMutation.failBoxReorderOnce = true
    await reorderBoxesDurably([secondBox.id, firstBox.id])
    expect(failures).toHaveBeenCalledOnce()
    expect([getTape(first.id)?.order, getTape(second.id)?.order]).toEqual([1, 0])
    expect(getBoxes().map((box) => [box.id, box.order])).toEqual([[firstBox.id, 1], [secondBox.id, 0]])

    await expect(persistNow()).resolves.toBe(true)
    const onDisk = JSON.parse(await readFile(join(testRoot, 'catalog.json'), 'utf8')) as { tapes: Tape[]; boxes: typeof firstBox[] }
    expect(onDisk.tapes.map((item) => [item.id, item.order])).toEqual([[first.id, 1], [second.id, 0]])
    expect(onDisk.boxes.map((item) => [item.id, item.order])).toEqual([[firstBox.id, 1], [secondBox.id, 0]])
    onCatalogSaveFailure(() => {})
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


describe('derived position indexes', () => {
  it('rebuilds positions after durable rename, removal and rebind', async () => {
    await loadSession()
    const first = tape()
    const second = tape('def1234567')
    upsertTape(first)
    upsertTape(second)
    await rename({ ...first, filename: 'Renamed.mp4' })
    removeTapes([first.id])
    upsertTape({ ...second, title: 'After removal' })
    expect(getTape(first.id)).toBeUndefined()
    expect(getTape(second.id)?.title).toBe('After removal')
    await persistNow()
    await loadSession()
    upsertTape({ ...getTape(second.id)!, title: 'After rebind' })
    expect(getTape(second.id)?.title).toBe('After rebind')
    expect(getTapes()).toHaveLength(1)
    await persistNow()
  })
})

describe('catalog publication', () => {
  it('keeps a committed rename dirty for metadata changed during publication', async () => {
    await loadSession()
    const original = tape()
    upsertTape(original)
    await persistNow()
    catalogMutation.saved = () => {
      catalogMutation.saved = null
      upsertTape({ ...original, title: 'New metadata' })
    }
    await rename({ ...original, name: 'Renamed', filename: 'Renamed.mp4' })
    await persistNow()
    const stored = JSON.parse(await readFile(join(testRoot, 'catalog.json'), 'utf8'))
    expect(stored.tapes[0]).toMatchObject({ title: 'New metadata', filename: 'Renamed.mp4' })
  })

  it('suppresses a redundant save after loading the same catalog', async () => {
    await loadSession()
    upsertTape(tape())
    await expect(persistNow()).resolves.toBe(true)
    await loadSession()
    record.mockClear()
    await expect(persistNow()).resolves.toBe(true)
    expect(record).not.toHaveBeenCalled()
  })
})
