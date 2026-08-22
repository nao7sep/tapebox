import { mkdir, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Tape } from '@shared/domain'

const testRoot = vi.hoisted(
  () => `${process.env.TEMP ?? process.env.TMPDIR ?? '/tmp'}/tapebox-session-terminal-${process.pid}`,
)
const recordBeforeExit = vi.hoisted(() => vi.fn())
const record = vi.hoisted(() => vi.fn())
const catalogMutation = vi.hoisted(() => ({ failRenamedOnce: false }))

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
      const value = args[1] as { tapes?: Tape[] }
      if (catalogMutation.failRenamedOnce && value.tapes?.some((item) => item.name === 'Renamed')) {
        catalogMutation.failRenamedOnce = false
        throw new Error('catalog disk full')
      }
      return actual.writeManagedJson(...args)
    }),
  }
})

import {
  loadSession,
  getTape,
  persistNow,
  persistNowSync,
  upsertBox,
  upsertTape,
  renameTapeDurably,
} from '@main/store/session'

function tape(): Tape {
  return {
    id: 'abc1234567', sourceUrl: 'https://example.test/watch', state: 'downloaded',
    addedAtUtc: '2026-01-01T00:00:00.000Z', sourceId: 'source', extractor: 'test',
    title: 'Title', uploader: null, durationSeconds: 1, chapterCount: 0,
    probedAtUtc: '2026-01-01T00:00:00.000Z', filename: 'Take.mp4',
    sidecarFilename: 'Take.json', thumbnailFilename: null, downloadStartedAtUtc: null,
    downloadedAtUtc: '2026-01-01T00:00:00.000Z', name: 'Take', renamedAtUtc: null,
    archivedAtUtc: null, boxId: null, order: 0, pausedAtUtc: null, failedAtUtc: null, lastError: null,
  }
}

beforeEach(async () => {
  recordBeforeExit.mockReset()
  record.mockReset()
  catalogMutation.failRenamedOnce = false
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
