vi.mock('@main/ipc/trust', () => ({ isTrustedApplicationSender: () => true }))
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ShelfSchema, type Session, type Tape } from '@shared/domain'
import type { IpcCalls } from '@shared/ipc-contract'
import { unwrapIpcReply, type IpcReply } from '@shared/ipc-reply'
import { header } from '../../helpers/file-header'

const state = vi.hoisted(() => ({
  handlers: new Map<string, (req: unknown) => Promise<unknown>>(),
  failConfig: false,
  cancelOnShelf: false,
  beforeShelf: null as null | (() => Promise<void>),
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
  if (channel === 'settings:collectionMoveProgress') state.progress?.(payload as { filesDone: number; filesTotal: number })
} }))
vi.mock('@main/io/atomic-json', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@main/io/atomic-json')>()
  // A collection's own shelf.json, not a sidecar of that name in a tape's folder.
  const isShelf = (file: string): boolean => /[\\/]shelf\.json$/.test(file) && !/[\\/](inbox|shelf)[\\/][^\\/]+[\\/]shelf\.json$/.test(file)
  const beforeWrite = async (file: string): Promise<void> => {
    if (isShelf(file)) await state.beforeShelf?.()
    if (state.cancelOnShelf && isShelf(file)) {
      state.cancelOnShelf = false
      await state.handlers.get('settings:cancelCollectionMove')!(undefined)
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
  state.cancelOnShelf = false
  state.beforeShelf = null
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
  const { ensureDirs, paths, shelfFile } = await import('@main/paths')
  await ensureDirs()
  const config = await import('@main/store/config')
  await config.loadSettings()
  const session = await import('@main/store/session')
  await session.loadSession()
  ;(await import('@main/ipc/settings')).registerSettingsHandlers()
  return { config, session, paths, shelfFile }
}
function update(patch: IpcCalls['settings:update']['req']) {
  return state.handlers.get('settings:update')!(patch) as Promise<IpcCalls['settings:update']['res']>
}
function tape(overrides: Partial<Tape> = {}): Tape {
  return {
    id: 'Tape123456', sourceUrl: 'https://example.test/watch', state: 'downloaded',
    addedAtUtc: '2026-01-01T00:00:00.000Z', addedIndex: 0, sourceId: 'source', extractor: 'test',
    title: 'Title', uploader: null, durationSeconds: 1, chapterCount: 0,
    probedAtUtc: null, filename: 'shelf.mp4', sidecarFilename: 'shelf.json', thumbnailFilename: null,
    downloadStartedAtUtc: null, downloadedAtUtc: '2026-01-01T00:01:00.000Z', name: 'shelf', renamedAtUtc: null,
    shelved: true, boxId: 'Box1234567', order: 0,
    pausedAtUtc: null, failedAtUtc: null, failureCode: null, lastError: null,
    ...overrides,
  }
}
async function seed() {
  const app = await start()
  app.session.upsertBox({ id: 'Box1234567', name: 'Kept box', order: 0 })
  app.session.upsertBox({ id: 'Box7654321', name: 'Second box', order: 1 })
  app.session.upsertTape(tape())
  app.session.upsertTape(tape({ id: 'Tape654321', sourceUrl: 'https://example.test/queued', state: 'paused', filename: null, sidecarFilename: null, name: null, shelved: false, boxId: null, order: 0 }))
  // A sidecar may share shelf.json's name: it sits in its tape's folder.
  const folder = join(app.config.getCollectionDir(), 'shelf', 'Tape123456')
  await mkdir(folder, { recursive: true })
  await writeFile(join(folder, 'shelf.mp4'), 'media bytes')
  await writeFile(join(folder, 'shelf.json'), 'ordinary sidecar bytes')
  await app.session.persistNow()
  return app
}
/** A session with its tapes by id, so the Inbox's and the cache's orders compare alike. */
function byId(session: Session): Session {
  return { tapes: [...session.tapes].sort((a, b) => a.id.localeCompare(b.id)), boxes: session.boxes }
}
/** The collection at `dir` as its files hold it. */
async function readAt(dir: string): Promise<Session> {
  const { readCollection } = await import('@main/store/session')
  const read = await readCollection(dir)
  return read.session
}
/** What the store holds, in its durable form. */
function held(app: Awaited<ReturnType<typeof start>>): Session {
  return byId({ tapes: app.session.getTapes().map(app.session.durableTape), boxes: app.session.getBoxes() })
}

describe('portable collection through settings and the actual collection owner', () => {
  it('opens a closed copied collection under fresh machine settings with all organization and queued work', async () => {
    const original = await seed()
    const copied = join(root, 'copied-collection')
    await cp(original.config.getCollectionDir(), copied, { recursive: true })
    const expected = await readAt(copied)
    expect(byId(expected)).toEqual(held(original))
    await rm(original.paths.root, { recursive: true })
    process.env.TAPEBOX_DATA_DIR = join(root, 'fresh-machine')
    vi.resetModules()
    const fresh = await start()
    await update({ collectionDir: copied, collectionAction: 'open' })
    expect(fresh.config.getCollectionDir()).toBe(copied)
    expect({ tapes: fresh.session.getTapes(), boxes: fresh.session.getBoxes() }).toEqual(expected)
    expect(await readFile(join(copied, 'shelf', 'Tape123456', 'shelf.json'), 'utf8')).toBe('ordinary sidecar bytes')
    expect(await readFile(join(copied, 'shelf', 'Tape123456', 'shelf.mp4'), 'utf8')).toBe('media bytes')
    expect(state.emit).toHaveBeenCalledWith('collection:opened', expected)
    fresh.session.upsertBox({ ...expected.boxes[0]!, name: 'Saved on new machine' })
    await fresh.session.persistNow()
    const stored = ShelfSchema.parse(JSON.parse(await readFile(fresh.shelfFile(copied), 'utf8')))
    expect(stored.boxes[0]!.name).toBe('Saved on new machine')
    const { record } = await import('@main/store/backupStore')
    expect(record).toHaveBeenLastCalledWith(fresh.shelfFile(copied), Buffer.from(await readFile(fresh.shelfFile(copied))))
    vi.resetModules()
    const reopened = await start()
    expect(reopened.config.getCollectionDir()).toBe(copied)
    expect(reopened.session.getBoxes()[0]!.name).toBe('Saved on new machine')
  })

  it('moves metadata and media together, preserving the source until config commits', async () => {
    const app = await seed()
    const from = app.config.getCollectionDir()
    const target = join(root, 'moved')
    await update({ collectionDir: target })
    expect(app.config.getCollectionDir()).toBe(target)
    expect(state.emit.mock.calls.some(([channel]) => channel === 'collection:opened')).toBe(false)
    expect(byId(await readAt(target))).toEqual(held(app))
    await expect(readFile(app.shelfFile(from))).rejects.toMatchObject({ code: 'ENOENT' })
    expect((await readdir(join(target, 'shelf', 'Tape123456'))).sort()).toEqual(['shelf.json', 'shelf.mp4', 'tape.json'])
    expect(await readdir(join(target, 'inbox', 'Tape654321'))).toEqual(['tape.json'])
    expect(await readdir(from), 'the moved tape folders, and the Inbox and Shelf holding them, go with their files').toEqual([])
    app.session.upsertBox({ id: 'Box1234567', name: 'After move', order: 0 })
    await app.session.persistNow()
    expect(await readFile(app.shelfFile(target), 'utf8')).toContain('After move')
  })

  it('carries a shelf change saved in the old folder during the move to the new one', async () => {
    const app = await seed()
    const target = join(root, 'moved')
    state.progress = ({ filesDone, filesTotal }) => {
      // After every file, the store's own included, has been copied.
      if (filesDone < filesTotal) return
      app.session.upsertBox({ id: 'Box1234567', name: 'During move', order: 0 })
      void app.session.persistNow()
    }
    await update({ collectionDir: target })
    expect(app.config.getCollectionDir()).toBe(target)
    expect(await readFile(app.shelfFile(target), 'utf8')).toContain('During move')
  })

  it('refuses to move over another collection even when media names do not collide', async () => {
    const app = await seed()
    const target = join(root, 'other')
    await mkdir(target, { recursive: true })
    const bytes = JSON.stringify({ ...header('shelf'), boxes: [], loose: [] })
    await writeFile(app.shelfFile(target), bytes)
    await expect(update({ collectionDir: target })).rejects.toThrow()
    expect(await readFile(app.shelfFile(target), 'utf8')).toBe(bytes)
    expect(app.config.getCollectionDir()).toBe(app.paths.collection)
    expect(await readdir(target)).toEqual(['shelf.json'])
  })

  it('keeps another settings save made while a collection switch runs', async () => {
    const app = await seed()
    const autoplay = app.config.getSettings().autoplay
    let competing: Promise<unknown> | undefined
    state.progress = () => {
      state.progress = null
      competing = update({ autoplay: !autoplay })
    }
    await update({ collectionDir: join(root, 'moved') })
    await competing
    expect(app.config.getSettings().autoplay).toBe(!autoplay)
    expect(app.config.getCollectionDir()).toBe(join(root, 'moved'))
  })

  it('rolls a cancelled move back including metadata without changing authority', async () => {
    const app = await seed()
    const target = join(root, 'cancelled')
    let progressEvents = 0
    state.progress = () => {
      if (++progressEvents < 2) return
      state.progress = null
      void state.handlers.get('settings:cancelCollectionMove')!(undefined)
    }
    await expect(update({ collectionDir: target })).rejects.toThrow()
    expect(app.config.getCollectionDir()).toBe(app.paths.collection)
    expect(await readFile(app.shelfFile(app.paths.collection), 'utf8')).toContain('Kept box')
    await expect(readFile(app.shelfFile(target))).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await readdir(target), 'the rolled-back copies leave no folders behind').toEqual([])
  })

  it.each(['move', 'open'] as const)('keeps the original collection and config if the %s location save fails', async (action) => {
    const app = await seed()
    const target = join(root, 'destination')
    if (action === 'open') await cp(app.config.getCollectionDir(), target, { recursive: true })
    const original = await readFile(app.shelfFile(app.paths.collection), 'utf8')
    const destination = action === 'open' ? await readFile(app.shelfFile(target), 'utf8') : null
    state.failConfig = true
    await expect(update({ collectionDir: target, ...(action === 'open' ? { collectionAction: 'open' as const } : {}) })).rejects.toThrow()
    expect(app.config.getCollectionDir()).toBe(app.paths.collection)
    expect(app.session.getBoxes()[0]!.name).toBe('Kept box')
    expect(await readFile(app.shelfFile(app.paths.collection), 'utf8')).toBe(original)
    if (destination) expect(await readFile(app.shelfFile(target), 'utf8')).toBe(destination)
    else await expect(readFile(app.shelfFile(target))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it.each(['absent', 'invalid', 'newer'])('refuses an %s opened shelf file without quarantine or writes', async (kind) => {
    const app = await seed()
    const target = join(root, kind)
    await mkdir(target, { recursive: true })
    const bytes = kind === 'invalid' ? '{broken' : JSON.stringify({ ...header('shelf', 999), boxes: [], loose: [] })
    if (kind !== 'absent') await writeFile(app.shelfFile(target), bytes)
    await expect(update({ collectionDir: target, collectionAction: 'open' })).rejects.toThrow('Could not open the collection at')
    expect(app.config.getCollectionDir()).toBe(app.paths.collection)
    expect(await readdir(target)).toEqual(kind === 'absent' ? [] : ['shelf.json'])
    if (kind !== 'absent') expect(await readFile(app.shelfFile(target), 'utf8')).toBe(bytes)
  })

  it('cancels opening after the outgoing flush without changing either collection', async () => {
    const app = await seed()
    const target = join(root, 'opened')
    await cp(app.config.getCollectionDir(), target, { recursive: true })
    const destination = await readFile(app.shelfFile(target), 'utf8')
    app.session.upsertBox({ id: 'Box1234567', name: 'Unsaved edit', order: 0 })
    state.cancelOnShelf = true
    await expect(update({ collectionDir: target, collectionAction: 'open' })).rejects.toThrow()
    expect(app.config.getCollectionDir()).toBe(app.paths.collection)
    expect(app.session.getBoxes()[0]!.name).toBe('Unsaved edit')
    expect(await readFile(app.shelfFile(app.paths.collection), 'utf8')).toContain('Unsaved edit')
    expect(await readFile(app.shelfFile(target), 'utf8')).toBe(destination)
    expect(state.emit.mock.calls.some(([channel]) => channel === 'collection:opened')).toBe(false)
  })

  it('lands a pending organization write in its original collection before opening another', async () => {
    const app = await seed()
    const target = join(root, 'other')
    await cp(app.config.getCollectionDir(), target, { recursive: true })
    ;(await import('@main/ipc/boxes')).registerBoxHandlers()
    let finish!: () => void
    let began!: () => void
    const started = new Promise<void>((resolve) => { began = resolve })
    const hold = new Promise<void>((resolve) => { finish = resolve })
    state.beforeShelf = async () => { state.beforeShelf = null; began(); await hold }
    const edit = state.handlers.get('boxes:reorder')!({ orderedIds: ['Box7654321', 'Box1234567'] })
    await started
    const opening = update({ collectionDir: target, collectionAction: 'open' })
    finish()
    await edit
    await opening
    expect(app.session.getBoxes().map((box) => box.id), 'the opened copy keeps its own order').toEqual(['Box1234567', 'Box7654321'])
    const saved = ShelfSchema.parse(JSON.parse(await readFile(app.shelfFile(app.paths.collection), 'utf8')))
    expect(saved.boxes.map((box) => box.id)).toEqual(['Box7654321', 'Box1234567'])
  })
})
