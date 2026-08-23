import { mkdir, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Box, Tape } from '@shared/domain'

const testRoot = vi.hoisted(
  () => `${process.env.TEMP ?? process.env.TMPDIR ?? '/tmp'}/tapebox-session-terminal-${process.pid}`,
)
const recordBeforeExit = vi.hoisted(() => vi.fn())
const record = vi.hoisted(() => vi.fn())
const catalogMutation = vi.hoisted(() => ({
  failRenamedOnce: false,
  failReorderOnce: false,
  failBoxReorderOnce: false,
}))

vi.mock('@main/paths', () => ({ paths: { catalog: join(testRoot, 'catalog.json') } }))
vi.mock('@main/store/backupStore', () => ({ record, recordBeforeExit }))
vi.mock('@main/io/logger', () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))
vi.mock('@main/io/atomic-json', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@main/io/atomic-json')>()
  return {
    ...actual,
    writeManagedJson: vi.fn(async (...args: Parameters<typeof actual.writeManagedJson>) => {
      const value = args[1] as { tapes?: Tape[]; boxes?: Box[] }
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
      return actual.writeManagedJson(...args)
    }),
  }
})

import {
  loadSession,
  getBoxes,
  getTape,
  persistNow,
  persistNowSync,
  upsertBox,
  upsertTape,
  renameTapeDurably,
  reorderTapesDurably,
  reorderBoxesDurably,
} from '@main/store/session'

function tape(id = 'abc1234567', order = 0): Tape {
  return {
    id, sourceUrl: `https://example.test/watch/${id}`, state: 'downloaded',
    addedAtUtc: '2026-01-01T00:00:00.000Z', sourceId: id, extractor: 'test',
    title: 'Title', uploader: null, durationSeconds: 1, chapterCount: 0,
    probedAtUtc: '2026-01-01T00:00:00.000Z', filename: `${id}.mp4`,
    sidecarFilename: `${id}.json`, thumbnailFilename: null, downloadStartedAtUtc: null,
    downloadedAtUtc: '2026-01-01T00:00:00.000Z', name: 'Take', renamedAtUtc: null,
    archivedAtUtc: null, boxId: null, order, pausedAtUtc: null, failedAtUtc: null, lastError: null,
  }
}

beforeEach(async () => {
  recordBeforeExit.mockReset()
  record.mockReset()
  catalogMutation.failRenamedOnce = false
  catalogMutation.failReorderOnce = false
  catalogMutation.failBoxReorderOnce = false
  await mkdir(testRoot, { recursive: true })
})

afterEach(async () => {
  await rm(testRoot, { recursive: true, force: true })
})

describe('terminal catalog persistence', () => {
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
    expect(catalog).toEqual({ tapes: [original], boxes: [box] })
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

  it('hands the exact published bytes to the fatal/exit recorder before returning', async () => {
    await loadSession()
    upsertBox({ id: 'box1234567', name: 'Keepers', order: 0 })

    persistNowSync()

    const catalogPath = join(testRoot, 'catalog.json')
    const published = await readFile(catalogPath)
    expect(recordBeforeExit).toHaveBeenCalledOnce()
    expect(recordBeforeExit).toHaveBeenCalledWith(catalogPath, expect.any(Buffer))
    expect(Buffer.from(recordBeforeExit.mock.calls[0]![1])).toEqual(published)
  })
})
