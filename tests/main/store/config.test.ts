import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// getLibraryDir() resolves the persisted libraryDir to a real path: blank means
// "use the default library folder" (paths.library); a set value is used as-is.
// This is what stops a cleared Settings field from ever producing a cwd-relative
// path (join('', file)). The dependencies are mocked so loadSettings() populates
// the in-memory cache without touching disk or the real storage root.

vi.mock('@main/paths', () => ({
  // Inlined, not a top-level const: vi.mock factories are hoisted above the file,
  // so they can't reference module-scope variables.
  paths: { library: '/mock/.tapebox/library', config: '/mock/.tapebox/config.json' },
}))

const DEFAULT_LIBRARY = '/mock/.tapebox/library'

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
import { getLibraryDir, getSettings, loadSettings, updateSettings } from '@main/store/config'

beforeEach(async () => {
  // No config.json on disk → loadSettings seeds the cache with defaults (blank
  // libraryDir). readFile is left real; the mocked config path doesn't exist, so
  // the read fails ENOENT and the defaults path is taken.
  await loadSettings()
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('getLibraryDir', () => {
  it('resolves a blank libraryDir to the default library folder', async () => {
    expect(getLibraryDir()).toBe(DEFAULT_LIBRARY)
  })

  it('resolves a whitespace-only libraryDir to the default library folder', async () => {
    await updateSettings({ libraryDir: '   ' })
    expect(getLibraryDir()).toBe(DEFAULT_LIBRARY)
  })

  it('uses a set libraryDir as-is', async () => {
    await updateSettings({ libraryDir: '/custom/library' })
    expect(getLibraryDir()).toBe('/custom/library')
  })

  it('keeps the last durable settings authoritative when a save fails', async () => {
    vi.mocked(writeManagedJson).mockRejectedValueOnce(new Error('disk full'))

    await expect(updateSettings({ libraryDir: '/not-durable' })).rejects.toThrow('disk full')

    expect(getSettings().libraryDir).toBe('')
    expect(getLibraryDir()).toBe(DEFAULT_LIBRARY)
  })
})
