vi.mock('@main/ipc/trust', () => ({ isTrustedApplicationSender: () => true }))
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SessionSchema, type Tape } from '@shared/domain'
import type { IpcCalls } from '@shared/ipc-contract'
import { unwrapIpcReply, type IpcReply } from '@shared/ipc-reply'

const state = vi.hoisted(() => ({
  handlers: new Map<string, (req: unknown) => Promise<unknown>>(),
  failConfig: false,
  cancelOnCatalog: false,
  beforeCatalog: null as null | (() => Promise<void>),
  progress: null as null | ((progress: { filesDone: number; filesTotal: number }) => void),
  tick: vi.fn(),
  emit: vi.fn(),
}))
vi.mock('electron', () => ({ ipcMain: { handle: (channel: string, fn: (event: unknown, req: unknown) => Promise<IpcReply<unknown>>) => {
  state.handlers.set(channel, async (req) => unwrapIpcReply(channel, await fn({}, req)))
} } }))
vi.mock('@main/store/backupStore', () => ({ record: vi.fn() }))
vi.mock('@main/io/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }))
vi.mock('@main/theme', () => ({ applyThemePreference: vi.fn(), systemAppearance: vi.fn(() => 'light') }))
vi.mock('@main/i18n', () => ({ applyLanguagePreference: vi.fn(), mainTranslator: () => ({ t: () => 'New Box' }) }))
vi.mock('@main/power-blocker', () => ({ reconcileWakeLock: vi.fn() }))
vi.mock('@main/queue/manager', () => ({ tick: state.tick, resumePaused: vi.fn(), hasActiveJobs: () => false }))
vi.mock('@main/ipc/events', () => ({ emit: (channel: string, payload: unknown) => {
  state.emit(channel, payload)
  if (channel === 'settings:libraryMoveProgress') state.progress?.(payload as { filesDone: number; filesTotal: number })
} }))
vi.mock('@main/io/atomic-json', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@main/io/atomic-json')>()
  const beforeWrite = async (file: string): Promise<void> => {
    if (file.endsWith('catalog.json')) await state.beforeCatalog?.()
    if (state.cancelOnCatalog && file.endsWith('catalog.json')) {
      state.cancelOnCatalog = false
      await state.handlers.get('settings:cancelLibraryMove')!(undefined)
    }
    if (state.failConfig && file.endsWith('config.json')) throw new Error('config storage unavailable')
  }
  return {
    ...actual,
    writeManagedJson: async (...args: Parameters<typeof actual.writeManagedJson>) => {
      await beforeWrite(args[0])
      return actual.writeManagedJson(...args)
    },
    writeManagedJsonBytes: async (...args: Parameters<typeof actual.writeManagedJsonBytes>) => {
      await beforeWrite(args[0])
      return actual.writeManagedJsonBytes(...args)
    },
  }
})

let root: string
const previousRoot = process.env.TAPEBOX_DATA_DIR
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'tapebox-portability-'))
  process.env.TAPEBOX_DATA_DIR = join(root, 'machine-a')
  state.handlers.clear()
  state.failConfig = false
  state.cancelOnCatalog = false
  state.beforeCatalog = null
  state.progress = null
  state.emit.mockClear()
  state.tick.mockClear()
  vi.resetModules()
})
afterEach(async () => {
  const session = await import('@main/store/session')
  await session.persistNow()
  if (previousRoot === undefined) delete process.env.TAPEBOX_DATA_DIR
  else process.env.TAPEBOX_DATA_DIR = previousRoot
  await rm(root, { recursive: true, force: true })
})

async function start() {
  const { ensureDirs, paths, collectionCatalog } = await import('@main/paths')
  await ensureDirs()
  const config = await import('@main/store/config')
  await config.loadSettings()
  const session = await import('@main/store/session')
  await session.loadSession()
  ;(await import('@main/ipc/settings')).registerSettingsHandlers()
  return { config, session, paths, collectionCatalog }
}
function update(patch: IpcCalls['settings:update']['req']) {
  return state.handlers.get('settings:update')!(patch) as Promise<IpcCalls['settings:update']['res']>
}
function tape(overrides: Partial<Tape> = {}): Tape {
  return {
    id: 'Tape123456', sourceUrl: 'https://example.test/watch', state: 'downloaded',
    addedAtUtc: '2026-01-01T00:00:00.000Z', sourceId: 'source', extractor: 'test',
    title: 'Title', uploader: null, durationSeconds: 1, chapterCount: 0,
    probedAtUtc: null, filename: 'catalog.mp4', sidecarFilename: 'catalog.json', thumbnailFilename: null,
    downloadStartedAtUtc: null, downloadedAtUtc: '2026-01-01T00:01:00.000Z', name: 'catalog', renamedAtUtc: null,
    archivedAtUtc: '2026-01-02T00:00:00.000Z', boxId: 'Box1234567', order: 3,
    pausedAtUtc: null, failedAtUtc: null, failureCode: null, lastError: null,
    ...overrides,
  }
}
async function seed() {
  const app = await start()
  app.session.upsertBox({ id: 'Box1234567', name: 'Kept box', order: 7 })
  app.session.upsertBox({ id: 'Box7654321', name: 'First box', order: 1 })
  app.session.upsertTape(tape())
  app.session.upsertTape(tape({ id: 'Tape654321', sourceUrl: 'https://example.test/queued', state: 'paused', filename: null, sidecarFilename: null, name: null, archivedAtUtc: null, boxId: null, order: -2 }))
  // A sidecar may share the catalog's name: it sits in its tape's folder.
  await mkdir(join(app.config.getLibraryDir(), 'Tape123456'))
  await writeFile(join(app.config.getLibraryDir(), 'Tape123456', 'catalog.mp4'), 'media bytes')
  await writeFile(join(app.config.getLibraryDir(), 'Tape123456', 'catalog.json'), 'ordinary sidecar bytes')
  await app.session.persistNow()
  return app
}

describe('portable collection through settings and the actual catalog owner', () => {
  it('opens a closed copied library under fresh machine settings with all organization and queued work', async () => {
    const original = await seed()
    const expected = { tapes: original.session.getTapes(), boxes: original.session.getBoxes() }
    const copied = join(root, 'copied-library')
    await cp(original.config.getLibraryDir(), copied, { recursive: true })
    await rm(original.paths.root, { recursive: true })
    process.env.TAPEBOX_DATA_DIR = join(root, 'fresh-machine')
    vi.resetModules()
    const fresh = await start()
    await update({ libraryDir: copied, libraryAction: 'open' })
    expect(fresh.config.getLibraryDir()).toBe(copied)
    expect({ tapes: fresh.session.getTapes(), boxes: fresh.session.getBoxes() }).toEqual(expected)
    expect(await readFile(join(copied, 'Tape123456', 'catalog.json'), 'utf8')).toBe('ordinary sidecar bytes')
    expect(await readFile(join(copied, 'Tape123456', 'catalog.mp4'), 'utf8')).toBe('media bytes')
    expect(state.emit).toHaveBeenCalledWith('library:opened', expected)
    fresh.session.upsertBox({ ...expected.boxes[0]!, name: 'Saved on new machine' })
    await fresh.session.persistNow()
    const stored = SessionSchema.parse(JSON.parse(await readFile(fresh.collectionCatalog(copied), 'utf8')))
    expect(stored.boxes[0]!.name).toBe('Saved on new machine')
    const { record } = await import('@main/store/backupStore')
    expect(record).toHaveBeenLastCalledWith(fresh.collectionCatalog(copied), Buffer.from(await readFile(fresh.collectionCatalog(copied))))
    vi.resetModules()
    const reopened = await start()
    expect(reopened.config.getLibraryDir()).toBe(copied)
    expect(reopened.session.getBoxes()[0]!.name).toBe('Saved on new machine')
  })

  it('moves metadata and media together, preserving the source until config commits', async () => {
    const app = await seed()
    const from = app.config.getLibraryDir()
    const target = join(root, 'moved')
    await update({ libraryDir: target })
    expect(app.config.getLibraryDir()).toBe(target)
    expect(state.emit.mock.calls.some(([channel]) => channel === 'library:opened')).toBe(false)
    expect(JSON.parse(await readFile(app.collectionCatalog(target), 'utf8')).boxes).toEqual(app.session.getBoxes())
    await expect(readFile(app.collectionCatalog(from))).rejects.toMatchObject({ code: 'ENOENT' })
    expect((await readdir(join(target, 'Tape123456'))).sort()).toEqual(['catalog.json', 'catalog.mp4'])
    expect(await readdir(from), 'the moved tape folder goes with its files').toEqual([])
    app.session.upsertBox({ id: 'Box1234567', name: 'After move', order: 7 })
    await app.session.persistNow()
    expect(await readFile(app.collectionCatalog(target), 'utf8')).toContain('After move')
  })

  it('carries a catalog change saved in the old folder during the move to the new one', async () => {
    const app = await seed()
    const target = join(root, 'moved')
    state.progress = ({ filesDone, filesTotal }) => {
      // After every file, the catalog included, has been copied.
      if (filesDone < filesTotal) return
      app.session.upsertBox({ id: 'Box1234567', name: 'During move', order: 7 })
      void app.session.persistNow()
    }
    await update({ libraryDir: target })
    expect(app.config.getLibraryDir()).toBe(target)
    expect(await readFile(app.collectionCatalog(target), 'utf8')).toContain('During move')
  })

  it('refuses to move over another collection even when media names do not collide', async () => {
    const app = await seed()
    const target = join(root, 'other')
    await mkdir(dirname(app.collectionCatalog(target)), { recursive: true })
    const bytes = JSON.stringify({ formatVersion: 1, tapes: [], boxes: [] })
    await writeFile(app.collectionCatalog(target), bytes)
    await expect(update({ libraryDir: target })).rejects.toThrow()
    expect(await readFile(app.collectionCatalog(target), 'utf8')).toBe(bytes)
    expect(app.config.getLibraryDir()).toBe(app.paths.library)
    expect(await readdir(target)).toEqual(['catalog.json'])
  })

  it('keeps another settings save made while a collection switch runs', async () => {
    const app = await seed()
    const autoplay = app.config.getSettings().autoplay
    let competing: Promise<unknown> | undefined
    state.progress = () => {
      state.progress = null
      competing = update({ autoplay: !autoplay })
    }
    await update({ libraryDir: join(root, 'moved') })
    await competing
    expect(app.config.getSettings().autoplay).toBe(!autoplay)
    expect(app.config.getLibraryDir()).toBe(join(root, 'moved'))
  })

  it('rolls a cancelled move back including metadata without changing authority', async () => {
    const app = await seed()
    const target = join(root, 'cancelled')
    let progressEvents = 0
    state.progress = () => {
      if (++progressEvents < 2) return
      state.progress = null
      void state.handlers.get('settings:cancelLibraryMove')!(undefined)
    }
    await expect(update({ libraryDir: target })).rejects.toThrow()
    expect(app.config.getLibraryDir()).toBe(app.paths.library)
    expect(await readFile(app.collectionCatalog(app.paths.library), 'utf8')).toContain('Kept box')
    await expect(readFile(app.collectionCatalog(target))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it.each(['move', 'open'] as const)('keeps the original collection and config if the %s location save fails', async (action) => {
    const app = await seed()
    const target = join(root, 'destination')
    if (action === 'open') await cp(app.config.getLibraryDir(), target, { recursive: true })
    const original = await readFile(app.collectionCatalog(app.paths.library), 'utf8')
    const destination = action === 'open' ? await readFile(app.collectionCatalog(target), 'utf8') : null
    state.failConfig = true
    await expect(update({ libraryDir: target, ...(action === 'open' ? { libraryAction: 'open' as const } : {}) })).rejects.toThrow()
    expect(app.config.getLibraryDir()).toBe(app.paths.library)
    expect(app.session.getBoxes()[0]!.name).toBe('Kept box')
    expect(await readFile(app.collectionCatalog(app.paths.library), 'utf8')).toBe(original)
    if (destination) expect(await readFile(app.collectionCatalog(target), 'utf8')).toBe(destination)
    else await expect(readFile(app.collectionCatalog(target))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it.each(['absent', 'invalid', 'newer'])('refuses an %s opened catalog without quarantine or writes', async (kind) => {
    const app = await seed()
    const target = join(root, kind)
    await mkdir(dirname(app.collectionCatalog(target)), { recursive: true })
    const bytes = kind === 'invalid' ? '{broken' : JSON.stringify({ formatVersion: 999, tapes: [], boxes: [] })
    if (kind !== 'absent') await writeFile(app.collectionCatalog(target), bytes)
    await expect(update({ libraryDir: target, libraryAction: 'open' })).rejects.toThrow('Could not open the library at')
    expect(app.config.getLibraryDir()).toBe(app.paths.library)
    expect(await readdir(dirname(app.collectionCatalog(target)))).toEqual(kind === 'absent' ? [] : ['catalog.json'])
    if (kind !== 'absent') expect(await readFile(app.collectionCatalog(target), 'utf8')).toBe(bytes)
  })

  it('cancels opening after the outgoing flush without changing either collection', async () => {
    const app = await seed()
    const target = join(root, 'opened')
    await cp(app.config.getLibraryDir(), target, { recursive: true })
    const destination = await readFile(app.collectionCatalog(target), 'utf8')
    app.session.upsertBox({ id: 'Box1234567', name: 'Unsaved edit', order: 7 })
    state.cancelOnCatalog = true
    await expect(update({ libraryDir: target, libraryAction: 'open' })).rejects.toThrow()
    expect(app.config.getLibraryDir()).toBe(app.paths.library)
    expect(app.session.getBoxes()[0]!.name).toBe('Unsaved edit')
    expect(await readFile(app.collectionCatalog(app.paths.library), 'utf8')).toContain('Unsaved edit')
    expect(await readFile(app.collectionCatalog(target), 'utf8')).toBe(destination)
    expect(state.emit.mock.calls.some(([channel]) => channel === 'library:opened')).toBe(false)
  })

  it('lands a pending organization write in its original collection before opening another', async () => {
    const app = await seed()
    const target = join(root, 'other')
    await cp(app.config.getLibraryDir(), target, { recursive: true })
    ;(await import('@main/ipc/boxes')).registerBoxHandlers()
    let finish!: () => void
    let began!: () => void
    const started = new Promise<void>((resolve) => { began = resolve })
    const hold = new Promise<void>((resolve) => { finish = resolve })
    state.beforeCatalog = async () => { state.beforeCatalog = null; began(); await hold }
    const edit = state.handlers.get('boxes:reorder')!({ orderedIds: ['Box1234567', 'Box7654321'] })
    await started
    const opening = update({ libraryDir: target, libraryAction: 'open' })
    finish()
    await edit
    await opening
    expect(app.session.getBoxes()[0]!.order).toBe(7)
    expect(JSON.parse(await readFile(app.collectionCatalog(app.paths.library), 'utf8')).boxes[0].order).toBe(0)
  })
})

describe('obsolete machine-root catalogs', () => {
  it('uses the collection catalog and leaves unrelated old catalog bytes in place', async () => {
    const { paths, collectionCatalog } = await import('@main/paths')
    await mkdir(dirname(collectionCatalog(paths.library)), { recursive: true })
    const obsolete = join(paths.root, 'catalog.json')
    const oldBytes = JSON.stringify({ tapes: [], boxes: [{ id: 'Box1234567', name: 'Old', order: 0 }] })
    await writeFile(obsolete, oldBytes)
    const current = JSON.stringify({ formatVersion: 1, tapes: [], boxes: [{ id: 'Box7654321', name: 'Current', order: 1 }] })
    await writeFile(collectionCatalog(paths.library), current)
    const app = await start()
    expect(app.session.getBoxes()[0]!.name).toBe('Current')
    expect(await readFile(collectionCatalog(paths.library), 'utf8')).toBe(current)
    expect(await readFile(obsolete, 'utf8')).toBe(oldBytes)
  })

  it('starts an empty collection when only an obsolete machine-root catalog exists', async () => {
    const { paths } = await import('@main/paths')
    await mkdir(paths.library, { recursive: true })
    const obsolete = join(paths.root, 'catalog.json')
    const oldBytes = JSON.stringify({ tapes: [], boxes: [{ id: 'Box1234567', name: 'Old', order: 0 }] })
    await writeFile(obsolete, oldBytes)
    const app = await start()
    expect(app.session.getTapes()).toEqual([])
    expect(app.session.getBoxes()).toEqual([])
    expect(await readFile(obsolete, 'utf8')).toBe(oldBytes)
  })
})
