import { homedir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { defaultSettings, type Settings } from '@shared/settings'

// The settings:update boundary owns two load-bearing safety behaviors that are
// otherwise untested:
//   - normalizeUserDir: a hand-typed libraryDir/defaultExportDir is normalized
//     before it is stored — blank stays blank, a leading ~ expands, and a relative
//     value is REJECTED so it can never resolve against the working directory
//     (which is `/` on a double-clicked build — storage-path-conventions).
//   - relocateIfLibraryDirChanged: moving the library is REFUSED while downloads
//     run, because an in-flight job finalizes files straight into the current
//     library dir; the move must not run and the new dir must not be committed.
//
// Both are internal to ipc/settings, so they're exercised through the registered
// settings:update handler — the real production boundary. ipcMain.handle is
// captured to invoke the handler directly; every collaborator is mocked so the
// test asserts pure decisions (did relocateLibrary run? did updateSettings get the
// normalized value?) without touching disk, the real queue, or the storage root.
// `node:os` (homedir) and `node:path` stay real, so the ~ expansion is genuine.

const handlers = new Map<string, (req: unknown) => unknown>()
vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, fn: (event: unknown, req: unknown) => unknown) => {
      handlers.set(channel, (req: unknown) => fn({}, req))
    },
  },
}))

const { activeCount } = vi.hoisted(() => ({ activeCount: vi.fn(() => 0) }))
vi.mock('@main/queue/manager', () => ({
  activeCount,
  resumePaused: vi.fn(),
}))

const { getSettings, getLibraryDir, updateSettings } = vi.hoisted(() => ({
  getSettings: vi.fn(),
  getLibraryDir: vi.fn(),
  updateSettings: vi.fn(),
}))
vi.mock('@main/store/config', () => ({ getSettings, getLibraryDir, updateSettings }))

const { completeLibraryRelocation, relocateLibrary, rollbackLibraryRelocation } = vi.hoisted(() => ({
  completeLibraryRelocation: vi.fn(),
  relocateLibrary: vi.fn(),
  rollbackLibraryRelocation: vi.fn(),
}))
vi.mock('@main/store/library-move', () => ({
  completeLibraryRelocation,
  relocateLibrary,
  rollbackLibraryRelocation,
}))

vi.mock('@main/store/session', () => ({ getTapes: vi.fn(() => []) }))
vi.mock('@main/services/api-keys', () => ({
  writeApiKey: vi.fn(),
  clearApiKey: vi.fn(),
  hasApiKey: vi.fn(() => false),
}))
vi.mock('@main/power-blocker', () => ({ reconcileWakeLock: vi.fn() }))
vi.mock('@main/paths', () => ({
  paths: { library: '/mock/.tapebox/library' },
}))
vi.mock('@main/io/logger', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))

const { registerSettingsHandlers } = await import('@main/ipc/settings')

function update(patch: Partial<Settings>): Promise<Settings> {
  const fn = handlers.get('settings:update')
  if (!fn) throw new Error('settings:update was not registered')
  return Promise.resolve(fn(patch) as Settings)
}

let base: Settings

beforeEach(() => {
  handlers.clear()
  base = defaultSettings()
  getSettings.mockReturnValue(base)
  getLibraryDir.mockReturnValue('/current/library')
  // updateSettings echoes the merged result, as the real one does, so the autostart
  // check in the handler sees a stable shape.
  updateSettings.mockImplementation(async (patch: Partial<Settings>) => ({ ...base, ...patch }))
  relocateLibrary.mockResolvedValue({ moved: false, reason: 'same-dir' })
  completeLibraryRelocation.mockResolvedValue(undefined)
  rollbackLibraryRelocation.mockResolvedValue(undefined)
  activeCount.mockReturnValue(0)
  registerSettingsHandlers()
})

afterEach(() => {
  vi.clearAllMocks()
})

describe('settings:update — normalizeUserDir at the boundary', () => {
  it('rejects a relative typed library folder (it must never reach a path join)', async () => {
    await expect(update({ libraryDir: 'relative/library' })).rejects.toThrow(/absolute path/)
    // The relative value must not have been stored, and no relocation attempted.
    expect(updateSettings).not.toHaveBeenCalled()
    expect(relocateLibrary).not.toHaveBeenCalled()
  })

  it('rejects a relative typed default export folder', async () => {
    await expect(update({ defaultExportDir: 'exports/here' })).rejects.toThrow(/absolute path/)
    expect(updateSettings).not.toHaveBeenCalled()
  })

  it('expands a ~ library folder to an absolute path under home', async () => {
    await update({ libraryDir: '~/Movies/tapebox' })
    expect(updateSettings).toHaveBeenCalledTimes(1)
    const stored = updateSettings.mock.calls[0]![0] as Partial<Settings>
    expect(stored.libraryDir).toBe(join(homedir(), 'Movies', 'tapebox'))
    expect(isAbsolute(stored.libraryDir!)).toBe(true)
  })

  it('expands a ~ default export folder to an absolute path under home', async () => {
    await update({ defaultExportDir: '~/Downloads' })
    const stored = updateSettings.mock.calls[0]![0] as Partial<Settings>
    expect(stored.defaultExportDir).toBe(join(homedir(), 'Downloads'))
  })

  it('keeps a blank library folder blank (the app default), not the cwd', async () => {
    await update({ libraryDir: '   ' })
    const stored = updateSettings.mock.calls[0]![0] as Partial<Settings>
    expect(stored.libraryDir).toBe('')
  })

  it('passes an already-absolute typed folder through unchanged', async () => {
    await update({ libraryDir: '/data/custom-library' })
    const stored = updateSettings.mock.calls[0]![0] as Partial<Settings>
    expect(stored.libraryDir).toBe('/data/custom-library')
  })
})

describe('settings:update — relocation refused while downloads run', () => {
  it('throws and moves nothing when the library dir changes during active downloads', async () => {
    activeCount.mockReturnValue(2)
    // A real change: from the current resolved dir to a new absolute custom folder.
    await expect(update({ libraryDir: '/data/new-library' })).rejects.toThrow(
      /downloads are running/i,
    )
    // The safety guard fires BEFORE the move and BEFORE the commit.
    expect(relocateLibrary).not.toHaveBeenCalled()
    expect(updateSettings).not.toHaveBeenCalled()
  })

  it('proceeds with the move and commit when no downloads are active', async () => {
    activeCount.mockReturnValue(0)
    relocateLibrary.mockResolvedValue({ moved: true, count: 0, crossDevice: false, files: [] })
    await update({ libraryDir: '/data/new-library' })
    expect(relocateLibrary).toHaveBeenCalledTimes(1)
    expect(updateSettings).toHaveBeenCalledTimes(1)
    expect(completeLibraryRelocation).toHaveBeenCalledWith([])
    const stored = updateSettings.mock.calls[0]![0] as Partial<Settings>
    expect(stored.libraryDir).toBe('/data/new-library')
  })

  it('removes destination claims when the durable settings save fails', async () => {
    const files = [
      {
        name: 'a.mp4',
        sourceClaim: { path: '/current/library/a.mp4', identity: '1:1' },
        claim: { path: '/data/new-library/a.mp4', identity: '2:1' },
      },
      {
        name: 'a.json',
        sourceClaim: { path: '/current/library/a.json', identity: '1:2' },
        claim: { path: '/data/new-library/a.json', identity: '2:2' },
      },
    ]
    relocateLibrary.mockResolvedValueOnce({ moved: true, count: 2, crossDevice: false, files })
    updateSettings.mockRejectedValueOnce(new Error('config disk full'))

    await expect(update({ libraryDir: '/data/new-library' })).rejects.toThrow('config disk full')

    expect(relocateLibrary).toHaveBeenNthCalledWith(1, '/current/library', '/data/new-library', [])
    expect(rollbackLibraryRelocation).toHaveBeenCalledWith(files)
    expect(completeLibraryRelocation).not.toHaveBeenCalled()
  })

  it('surfaces an exact recovery path when settings rollback is incomplete', async () => {
    const recoveryPath = '/data/new-library/a-rollback-recovery.tmp'
    const files = [
      {
        name: 'a.mp4',
        sourceClaim: { path: '/current/library/a.mp4', identity: '1:1' },
        claim: { path: '/data/new-library/a.mp4', identity: '2:1' },
      },
    ]
    relocateLibrary.mockResolvedValueOnce({ moved: true, count: 1, crossDevice: false, files })
    updateSettings.mockRejectedValueOnce(new Error('config disk full'))
    rollbackLibraryRelocation.mockRejectedValueOnce(
      new AggregateError([new Error(`Recovery claim remains at ${recoveryPath}`)], 'rollback incomplete'),
    )

    const failure = update({ libraryDir: '/data/new-library' })
    await expect(failure).rejects.toThrow(/Settings could not be saved/)
    await expect(failure).rejects.toThrow(recoveryPath)
  })

  it('reports post-commit source cleanup as partial success without rolling back the destination', async () => {
    const sourcePath = '/current/library/a.mp4'
    const files = [{
      name: 'a.mp4',
      sourceClaim: { path: sourcePath, identity: '1:1' },
      claim: { path: '/data/new-library/a.mp4', identity: '2:1' },
    }]
    relocateLibrary.mockResolvedValueOnce({ moved: true, count: 1, crossDevice: false, files })
    completeLibraryRelocation.mockRejectedValueOnce(
      new AggregateError([new Error(`Source claim remains at ${sourcePath}`)], 'cleanup incomplete'),
    )

    const failure = update({ libraryDir: '/data/new-library' })
    await expect(failure).rejects.toThrow(/Settings were saved and the new library is authoritative/)
    await expect(failure).rejects.toThrow(sourcePath)
    expect(updateSettings).toHaveBeenCalledOnce()
    expect(rollbackLibraryRelocation).not.toHaveBeenCalled()
  })
})
