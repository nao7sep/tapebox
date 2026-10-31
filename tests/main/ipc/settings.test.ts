vi.mock('@main/ipc/trust', () => ({ isTrustedApplicationSender: () => true }))
import { unwrapIpcReply, type IpcReply } from '@shared/ipc-reply'
import { homedir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { defaultSettings, type Settings } from '@shared/settings'
import type { Message } from '@shared/i18n/translate'
import { inEnglish } from '../../helpers/i18n'
import { until } from '../../helpers/until'

// The settings:update boundary owns two load-bearing safety behaviors that are
// otherwise untested:
//   - normalizeUserDir: a hand-typed collectionDir/defaultExportDir is normalized
//     before it is stored — blank stays blank, a leading ~ expands, and a relative
//     value is REJECTED so it can never resolve against the working directory
//     (which is `/` on a double-clicked build — storage-path-conventions).
//   - relocateIfCollectionDirChanged: moving the collection is REFUSED while downloads
//     run, because an in-flight job finalizes files straight into the current
//     collection dir; the move must not run and the new dir must not be committed.
//
// Both are internal to ipc/settings, so they're exercised through the registered
// settings:update handler — the real production boundary. ipcMain.handle is
// captured to invoke the handler directly; every collaborator is mocked so the
// test asserts pure decisions (did relocateCollection run? did updateSettings get the
// normalized value?) without touching disk, the real queue, or the storage root.
// `node:os` (homedir) and `node:path` stay real, so the ~ expansion is genuine.

const handlers = new Map<string, (req: unknown) => unknown>()
vi.mock('@main/theme', () => ({ applyThemePreference: vi.fn() }))
vi.mock('@main/i18n', () => ({ applyLanguagePreference: vi.fn(async () => false) }))
vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, fn: (event: unknown, req: unknown) => unknown) => {
      handlers.set(channel, async (req: unknown) => unwrapIpcReply(channel, (await fn({}, req)) as IpcReply<unknown>))
    },
  },
}))

const { tick, hasActiveJobs } = vi.hoisted(() => ({ tick: vi.fn(), hasActiveJobs: vi.fn(() => false) }))
vi.mock('@main/queue/manager', () => ({
  resumePaused: vi.fn(),
  tick,
  hasActiveJobs,
}))
vi.mock('@main/ipc/events', () => ({ emit: vi.fn() }))

const { getSettings, getCollectionDir, updateSettings } = vi.hoisted(() => ({
  getSettings: vi.fn(),
  getCollectionDir: vi.fn(),
  updateSettings: vi.fn(),
}))
vi.mock('@main/store/config', () => ({ getSettings, getCollectionDir, updateSettings }))

const { completeCollectionRelocation, relocateCollection, rollbackCollectionRelocation } = vi.hoisted(() => ({
  completeCollectionRelocation: vi.fn(),
  relocateCollection: vi.fn(),
  rollbackCollectionRelocation: vi.fn(),
}))
const logError = vi.hoisted(() => vi.fn())
vi.mock('@main/store/collection-move', () => ({
  completeCollectionRelocation,
  relocateCollection,
  rollbackCollectionRelocation,
}))

vi.mock('@main/store/session', () => ({
  getTapes: vi.fn(() => []), collectionStoreFiles: vi.fn(() => ['shelf.json']), copyStoreFileTo: vi.fn(),
  prepareCollection: vi.fn(async () => {}), bindMovedSession: vi.fn(async () => true), persistNow: vi.fn(async () => true),
  bindSession: vi.fn(), openCollection: vi.fn(),
}))
vi.mock('@main/services/api-keys', () => ({
  writeApiKey: vi.fn(),
  clearApiKey: vi.fn(),
  hasApiKey: vi.fn(() => false),
}))
vi.mock('@main/power-blocker', () => ({ reconcileWakeLock: vi.fn() }))
vi.mock('@main/paths', async (importOriginal) => ({
  ...await importOriginal<typeof import('@main/paths')>(),
  paths: { collection: '/mock/.tapebox/collection' },
}))
vi.mock('@main/io/logger', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: logError, debug: vi.fn() },
}))

const { registerSettingsHandlers } = await import('@main/ipc/settings')
const { isCollectionMoving, withCollectionTurn } = await import('@main/collection-writes')

function update(patch: Partial<Settings>): Promise<{ settings: Settings; warning: Message | null }> {
  const fn = handlers.get('settings:update')
  if (!fn) throw new Error('settings:update was not registered')
  return Promise.resolve(fn(patch) as { settings: Settings; warning: Message | null })
}

let base: Settings

beforeEach(() => {
  handlers.clear()
  base = defaultSettings()
  getSettings.mockReturnValue(base)
  getCollectionDir.mockReturnValue('/current/collection')
  // updateSettings echoes the merged result, as the real one does, so the autostart
  // check in the handler sees a stable shape.
  updateSettings.mockImplementation(async (patch: Partial<Settings>) => ({ ...base, ...patch }))
  relocateCollection.mockResolvedValue({ moved: false, reason: 'same-dir' })
  completeCollectionRelocation.mockResolvedValue(undefined)
  rollbackCollectionRelocation.mockResolvedValue(undefined)
  registerSettingsHandlers()
})

afterEach(() => {
  vi.clearAllMocks()
})

// A window that keeps no settings of its own (Records) follows the saved display zone.
describe('settings:update and the display zone', () => {
  it('tells other windows the zone saved', async () => {
    const { emit } = await import('@main/ipc/events')
    await update({ timeZone: 'Asia/Tokyo' })
    expect(emit).toHaveBeenCalledWith('settings:timeZoneChanged', 'Asia/Tokyo')
  })
})

describe('settings:update effects', () => {
  it('leaves appearance and window display events alone for unrelated saves', async () => {
    const { applyThemePreference } = await import('@main/theme')
    const { emit } = await import('@main/ipc/events')
    await update({ autoStartDownloads: !base.autoStartDownloads })
    expect(applyThemePreference).not.toHaveBeenCalled()
    expect(emit).not.toHaveBeenCalled()
  })

  it('publishes a changed font to other documents, including clearing it', async () => {
    const { emit } = await import('@main/ipc/events')
    await update({ uiFontFamily: 'Georgia' })
    expect(emit).toHaveBeenCalledWith('settings:uiFontChanged', 'Georgia')
    base.uiFontFamily = 'Georgia'
    await update({ uiFontFamily: '' })
    expect(emit).toHaveBeenCalledWith('settings:uiFontChanged', '')
  })
})

describe('settings:update — normalizeUserDir at the boundary', () => {
  it('rejects a relative typed collection folder (it must never reach a path join)', async () => {
    await expect(update({ collectionDir: 'relative/collection' })).rejects.toThrow('Collection folder must be an absolute path')
    // The relative value must not have been stored, and no relocation attempted.
    expect(updateSettings).not.toHaveBeenCalled()
    expect(relocateCollection).not.toHaveBeenCalled()
  })

  it('rejects a relative typed default export folder', async () => {
    await expect(update({ defaultExportDir: 'exports/here' })).rejects.toThrow('Default export folder must be an absolute path')
    expect(updateSettings).not.toHaveBeenCalled()
  })

  it('expands a ~ collection folder to an absolute path under home', async () => {
    await update({ collectionDir: '~/Movies/tapebox' })
    expect(updateSettings).toHaveBeenCalledTimes(1)
    const stored = updateSettings.mock.calls[0]![0] as Partial<Settings>
    expect(stored.collectionDir).toBe(join(homedir(), 'Movies', 'tapebox'))
    expect(isAbsolute(stored.collectionDir!)).toBe(true)
  })

  it('expands a ~ default export folder to an absolute path under home', async () => {
    await update({ defaultExportDir: '~/Downloads' })
    const stored = updateSettings.mock.calls[0]![0] as Partial<Settings>
    expect(stored.defaultExportDir).toBe(join(homedir(), 'Downloads'))
  })

  it('expands a Windows-style ~\\ folder under home on any host', async () => {
    await update({ defaultExportDir: '~\\Videos' })
    const stored = updateSettings.mock.calls[0]![0] as Partial<Settings>
    expect(stored.defaultExportDir).toBe(join(homedir(), 'Videos'))
  })

  // Whether a drive-letter path is absolute is the host's own path rule.
  it.runIf(process.platform === 'win32')('accepts a Windows drive-letter folder as absolute', async () => {
    await update({ defaultExportDir: 'D:\\Videos\\Exports' })
    const stored = updateSettings.mock.calls[0]![0] as Partial<Settings>
    expect(stored.defaultExportDir).toBe('D:\\Videos\\Exports')
  })

  it('keeps a blank collection folder blank (the app default), not the cwd', async () => {
    await update({ collectionDir: '   ' })
    const stored = updateSettings.mock.calls[0]![0] as Partial<Settings>
    expect(stored.collectionDir).toBe('')
  })

  it('keeps a native absolute folder with expression characters and trailing spaces literal', async () => {
    const directory = join(homedir(), '$NOT_EXPANDED%literal% ')
    await update({ defaultExportDir: directory, collectionDir: directory })
    expect(updateSettings).toHaveBeenCalledWith(expect.objectContaining({ defaultExportDir: directory, collectionDir: directory }))
  })

  it('passes an already-absolute typed folder through unchanged', async () => {
    await update({ collectionDir: '/data/custom-collection' })
    const stored = updateSettings.mock.calls[0]![0] as Partial<Settings>
    expect(stored.collectionDir).toBe('/data/custom-collection')
  })
})

describe('settings:update — relocation at its collection turn', () => {
  it('throws and moves nothing when the collection folder changes while a download runs', async () => {
    hasActiveJobs.mockReturnValueOnce(true)
    // A real change: from the current resolved dir to a new absolute custom folder.
    await expect(update({ collectionDir: '/data/new-collection' })).rejects.toThrow(
      "Can't move the collection while downloads are running.",
    )
    // The safety guard fires BEFORE the move and BEFORE the commit.
    expect(relocateCollection).not.toHaveBeenCalled()
    expect(updateSettings).not.toHaveBeenCalled()
  })

  it('waits for a collection action in progress, then moves', async () => {
    relocateCollection.mockResolvedValue({ moved: true, count: 0, crossDevice: false, files: [] })
    let finishImport!: () => void
    const importing = withCollectionTurn(() => new Promise<void>((resolve) => { finishImport = resolve }))
    const pending = update({ collectionDir: '/data/new-collection' })
    await Promise.resolve()
    expect(relocateCollection).not.toHaveBeenCalled()
    finishImport()
    await importing
    await pending
    expect(relocateCollection).toHaveBeenCalledOnce()
    expect(updateSettings).toHaveBeenCalledOnce()
  })

  it('saves other settings while a collection action runs when the folder is unchanged', async () => {
    let finishImport!: () => void
    const importing = withCollectionTurn(() => new Promise<void>((resolve) => { finishImport = resolve }))
    await update({ autoplay: false })
    expect(updateSettings).toHaveBeenCalledOnce()
    finishImport()
    await importing
  })

  it('proceeds with the move and commit when no collection write is in flight', async () => {
    relocateCollection.mockResolvedValue({ moved: true, count: 0, crossDevice: false, files: [] })
    await update({ collectionDir: '/data/new-collection' })
    expect(relocateCollection).toHaveBeenCalledTimes(1)
    expect(updateSettings).toHaveBeenCalledTimes(1)
    expect(completeCollectionRelocation).toHaveBeenCalledWith([])
    const stored = updateSettings.mock.calls[0]![0] as Partial<Settings>
    expect(stored.collectionDir).toBe('/data/new-collection')
  })

  it('removes destination claims when the durable settings save fails', async () => {
    const files = [
      {
        name: 'a.mp4',
        sourceClaim: { path: '/current/collection/a.mp4', identity: '1:1' },
        claim: { path: '/data/new-collection/a.mp4', identity: '2:1' },
      },
      {
        name: 'a.json',
        sourceClaim: { path: '/current/collection/a.json', identity: '1:2' },
        claim: { path: '/data/new-collection/a.json', identity: '2:2' },
      },
    ]
    relocateCollection.mockResolvedValueOnce({ moved: true, count: 2, crossDevice: false, files })
    updateSettings.mockRejectedValueOnce(new Error('config disk full'))

    await expect(update({ collectionDir: '/data/new-collection' })).rejects.toThrow('The operation could not be completed.')

    expect(relocateCollection).toHaveBeenNthCalledWith(1, '/current/collection', '/data/new-collection', ['shelf.json'], expect.objectContaining({ signal: expect.any(AbortSignal) }))
    expect(rollbackCollectionRelocation).toHaveBeenCalledWith(files)
    expect(completeCollectionRelocation).not.toHaveBeenCalled()
  })

  it('keeps an exact rollback recovery path in diagnostics, not the rejection copy', async () => {
    const recoveryPath = '/data/new-collection/a-rollback-recovery.tmp'
    const files = [
      {
        name: 'a.mp4',
        sourceClaim: { path: '/current/collection/a.mp4', identity: '1:1' },
        claim: { path: '/data/new-collection/a.mp4', identity: '2:1' },
      },
    ]
    relocateCollection.mockResolvedValueOnce({ moved: true, count: 1, crossDevice: false, files })
    updateSettings.mockRejectedValueOnce(new Error('config disk full'))
    rollbackCollectionRelocation.mockRejectedValueOnce(
      new AggregateError([new Error(`Recovery claim remains at ${recoveryPath}`)], 'rollback incomplete'),
    )

    const failure = update({ collectionDir: '/data/new-collection' })
    await expect(failure).rejects.toThrow('The operation could not be completed.')
    expect(JSON.stringify(logError.mock.calls)).toContain(recoveryPath)
  })

  it('reports a post-commit cleanup failure as a warning on a successful save', async () => {
    const sourcePath = '/current/collection/a.mp4'
    const files = [{
      name: 'a.mp4',
      sourceClaim: { path: sourcePath, identity: '1:1' },
      claim: { path: '/data/new-collection/a.mp4', identity: '2:1' },
    }]
    relocateCollection.mockResolvedValueOnce({ moved: true, count: 1, crossDevice: false, files })
    completeCollectionRelocation.mockRejectedValueOnce(
      new AggregateError([new Error(`Source claim remains at ${sourcePath}`)], 'cleanup incomplete'),
    )

    const result = await update({ collectionDir: '/data/new-collection' })
    expect(result.settings.collectionDir).toBe('/data/new-collection')
    expect(inEnglish(result.warning)).toMatch(/saved and the collection now uses the new folder/)
    expect(inEnglish(result.warning)).not.toContain(sourcePath)
    expect(JSON.stringify(logError.mock.calls)).toContain(sourcePath)
    expect(updateSettings).toHaveBeenCalledOnce()
    expect(rollbackCollectionRelocation).not.toHaveBeenCalled()
  })
})

describe('settings:update — collection move control', () => {
  it.each(['disk', 'rollback'])('keeps a %s failure distinct from a concurrent Stop request', async (kind) => {
    relocateCollection.mockImplementation((_from: string, _to: string, _entries: string[], options: { signal: AbortSignal }) => new Promise((_resolve, reject) => {
      options.signal.addEventListener('abort', () => reject(kind === 'disk'
        ? new Error('disk failed')
        : new AggregateError([options.signal.reason, new Error('rollback failed')], 'rollback incomplete')), { once: true })
    }))
    const pending = update({ collectionDir: '/data/new-collection' })
    await until(() => expect(relocateCollection).toHaveBeenCalledOnce())
    await handlers.get('settings:cancelCollectionMove')!(undefined)
    await expect(pending).rejects.toMatchObject({ code: 'internal' })
    expect(updateSettings).not.toHaveBeenCalled()
  })

  it('holds off downloads while the move runs, and Stop Move aborts it without committing', async () => {
    const seenDuringMove: boolean[] = []
    relocateCollection.mockImplementation((_from: string, _to: string, _entries: string[], options: { signal: AbortSignal }) => {
      seenDuringMove.push(isCollectionMoving())
      return new Promise((_resolve, reject) => {
        options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true })
      })
    })

    const pending = update({ collectionDir: '/data/new-collection' })
    await until(() => expect(relocateCollection).toHaveBeenCalledTimes(1))
    await handlers.get('settings:cancelCollectionMove')!(undefined)

    await expect(pending).rejects.toMatchObject({ code: 'cancelled' })
    expect(seenDuringMove).toEqual([true])
    expect(isCollectionMoving()).toBe(false)
    // The queue catches up once the move has settled.
    expect(tick).toHaveBeenCalled()
    expect(updateSettings).not.toHaveBeenCalled()
  })
})


describe('settings:update download concurrency', () => {
  it('fills newly available slots immediately when autostart is enabled', async () => {
    await update({ maxConcurrentDownloads: base.maxConcurrentDownloads + 1 })
    expect(tick).toHaveBeenCalledOnce()
  })

  it('does not start waiting downloads when autostart is disabled', async () => {
    base.autoStartDownloads = false
    await update({ maxConcurrentDownloads: base.maxConcurrentDownloads + 1 })
    expect(tick).not.toHaveBeenCalled()
  })

  it('leaves running downloads alone when the cap decreases', async () => {
    await update({ maxConcurrentDownloads: 1 })
    expect(tick).not.toHaveBeenCalled()
  })

  it('resumes paused downloads when autostart is enabled together with a higher cap', async () => {
    const { resumePaused } = await import('@main/queue/manager')
    base.autoStartDownloads = false
    await update({ autoStartDownloads: true, maxConcurrentDownloads: 3 })
    expect(resumePaused).toHaveBeenCalledOnce()
    expect(tick).not.toHaveBeenCalled()
  })
})
