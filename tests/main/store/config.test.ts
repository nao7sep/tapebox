import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// getCollectionDir() resolves the persisted collectionDir to a real path: blank means
// "use the default collection folder" (paths.collection); a set value is used as-is.
// This is what stops a cleared Settings field from ever producing a cwd-relative
// path (join('', file)). The dependencies are mocked so loadSettings() populates
// the in-memory cache without touching disk or the real storage root.

vi.mock('@main/paths', () => ({
  // Inlined, not a top-level const: vi.mock factories are hoisted above the file,
  // so they can't reference module-scope variables.
  paths: { collection: '/mock/.tapebox/collection', config: '/mock/.tapebox/config.json' },
}))

const DEFAULT_COLLECTION = '/mock/.tapebox/collection'

// config.ts saves through the managed-text choke point (writeManagedJson), which
// is what records to the data-backup store; stub it (and writeJsonAtomic) so this
// resolution test touches neither disk nor the backup store.
vi.mock('@main/io/atomic-json', () => ({
  writeJsonAtomic: vi.fn(async () => {}),
  writeManagedJson: vi.fn(async () => {}),
}))

vi.mock('@main/io/logger', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))

import { writeManagedJson } from '@main/io/atomic-json'
import { getCollectionDir, getSettings, loadSettings, updateSettings } from '@main/store/config'

beforeEach(async () => {
  // No config.json on disk → loadSettings uses built-ins in memory (blank
  // collectionDir). readFile is left real; the mocked config path doesn't exist, so
  // the read fails ENOENT and the defaults path is taken.
  await loadSettings()
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('getCollectionDir', () => {
  it('resolves a blank collectionDir to the default collection folder', async () => {
    expect(getCollectionDir()).toBe(DEFAULT_COLLECTION)
  })

  it('refuses a whitespace-only collectionDir and keeps the default collection folder', async () => {
    await expect(updateSettings({ collectionDir: '   ' })).rejects.toThrow()
    expect(getCollectionDir()).toBe(DEFAULT_COLLECTION)
  })

  it('uses a set collectionDir as-is', async () => {
    await updateSettings({ collectionDir: '/custom/collection' })
    expect(getCollectionDir()).toBe('/custom/collection')
  })

  it('keeps the last durable settings authoritative when a save fails', async () => {
    vi.mocked(writeManagedJson).mockRejectedValueOnce(new Error('disk full'))

    await expect(updateSettings({ collectionDir: '/not-durable' })).rejects.toThrow('disk full')

    expect(getSettings().collectionDir).toBe('')
    expect(getCollectionDir()).toBe(DEFAULT_COLLECTION)
  })
})
