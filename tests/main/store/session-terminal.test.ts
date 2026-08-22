import { mkdir, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const testRoot = vi.hoisted(
  () => `${process.env.TEMP ?? process.env.TMPDIR ?? '/tmp'}/tapebox-session-terminal-${process.pid}`,
)
const recordBeforeExit = vi.hoisted(() => vi.fn())

vi.mock('@main/paths', () => ({ paths: { catalog: join(testRoot, 'catalog.json') } }))
vi.mock('@main/store/backupStore', () => ({ recordBeforeExit }))
vi.mock('@main/io/logger', () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

import { loadSession, persistNowSync, upsertBox } from '@main/store/session'

beforeEach(async () => {
  recordBeforeExit.mockReset()
  await mkdir(testRoot, { recursive: true })
})

afterEach(async () => {
  await rm(testRoot, { recursive: true, force: true })
})

describe('terminal catalog persistence', () => {
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
