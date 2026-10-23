vi.mock('@main/ipc/trust', () => ({ isTrustedApplicationSender: () => true }))
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SessionSchema, type Tape } from '@shared/domain'
import { unwrapIpcReply, type IpcReply } from '@shared/ipc-reply'

const state = vi.hoisted(() => ({
  catalog: '', holdNext: false, failHeld: false,
  started: () => {}, release: null as Promise<void> | null,
}))
const emit = vi.hoisted(() => vi.fn())
const handlers = new Map<string, (req: unknown) => Promise<unknown>>()
vi.mock('electron', () => ({
  ipcMain: { handle: (channel: string, fn: (event: unknown, req: unknown) => unknown) => {
    handlers.set(channel, async (req) => unwrapIpcReply(channel, await fn({}, req) as IpcReply<unknown>))
  } },
  shell: { showItemInFolder: vi.fn(), openPath: vi.fn(), trashItem: vi.fn() },
}))
vi.mock('@main/paths', () => ({ paths: { get legacyCatalog() { return state.catalog + '.legacy' } }, collectionCatalog: () => state.catalog }))
vi.mock('@main/store/config', () => ({ getLibraryDir: () => join(state.catalog, '..'), getSettings: () => ({ trashOnRemove: false, externalPlayer: '' }) }))
vi.mock('@main/store/backupStore', () => ({ record: vi.fn() }))
vi.mock('@main/io/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }))
vi.mock('@main/ipc/events', () => ({ emit }))
vi.mock('@main/i18n', () => ({ mainTranslator: () => ({ t: () => 'New Box' }) }))
vi.mock('@main/queue/manager', () => ({ isActive: vi.fn(() => false), cancel: vi.fn() }))
vi.mock('@main/services/ytdlp', () => ({ downloadThumbnail: vi.fn(), probe: vi.fn() }))
vi.mock('@main/services/ffmpeg', () => ({ saveThumbnailJpeg: vi.fn() }))
vi.mock('@main/io/atomic-json', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@main/io/atomic-json')>()
  return {
    ...actual,
    writeManagedJsonBytes: async (...args: Parameters<typeof actual.writeManagedJsonBytes>) => {
      if (state.holdNext) {
        state.holdNext = false
        state.started()
        await state.release
        if (state.failHeld) { state.failHeld = false; throw new Error('required reorder write failed') }
      }
      return actual.writeManagedJsonBytes(...args)
    },
  }
})

import { registerLibraryHandlers } from '@main/ipc/library'
import { registerBoxHandlers } from '@main/ipc/boxes'
import * as session from '@main/store/session'

const ARCHIVED = '2026-10-11T00:00:00.000Z'
const SOURCE = 'SourceBox1'
const DEST = 'DestBox001'
let root = ''
let releaseHeld: (() => void) | null = null

function tape(id: string, order: number, boxId: string | null = SOURCE): Tape {
  return {
    id, order, sourceUrl: `https://example.test/${id}`, state: 'downloaded', addedAtUtc: ARCHIVED,
    sourceId: null, extractor: null, title: id, uploader: null, durationSeconds: null, chapterCount: null,
    probedAtUtc: null, filename: null, sidecarFilename: null, thumbnailFilename: null,
    downloadStartedAtUtc: null, downloadedAtUtc: ARCHIVED, name: null, renamedAtUtc: null,
    archivedAtUtc: ARCHIVED, boxId, pausedAtUtc: null, failedAtUtc: null, failureCode: null, lastError: null,
  }
}

async function seed(tapes: Tape[]) {
  for (const item of tapes) session.upsertTape(item)
  await session.persistNow()
  emit.mockClear()
}

function holdNextWrite() {
  let started!: () => void
  let release!: () => void
  const held = new Promise<void>((resolve) => { started = resolve })
  state.release = new Promise<void>((resolve) => { release = resolve; releaseHeld = resolve })
  state.started = started
  state.holdNext = true
  return { held, release: () => { release(); if (releaseHeld === release) releaseHeld = null } }
}

const invoke = (channel: string, req: unknown) => handlers.get(channel)!(req)
const reorder = (ids: string[]) => invoke('tapes:reorder', { orderedIds: ids })
const place = (id: string, boxId: string | null) => invoke('boxes:place', { tapeIds: [id], boxId })
const rows = () => session.getTapes().map(({ id, boxId, order }) => [id, boxId, order])
const listing = (boxId: string | null) => session.getTapes().filter((item) => item.archivedAtUtc && item.boxId === boxId).sort((a, b) => a.order - b.order).map(({ id, order }) => [id, order])
const lastReorderRows = () => emit.mock.calls.filter(([channel]) => channel === 'tapes:updatedMany').at(-1)![1] as Tape[]

async function expectCurrentSaved() {
  await expect(session.persistNow()).resolves.toBe(true)
  const saved = SessionSchema.parse(JSON.parse(await readFile(state.catalog, 'utf8')))
  expect(saved.tapes).toEqual(session.getTapes().map(session.durableTape))
  expect(saved.boxes).toEqual(session.getBoxes())
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'tapebox-reorder-concurrency-'))
  state.catalog = join(root, 'catalog.json')
  state.holdNext = false
  state.failHeld = false
  state.release = null
  handlers.clear()
  await session.loadSession()
  session.upsertBox({ id: SOURCE, name: 'Source', order: 0 })
  session.upsertBox({ id: DEST, name: 'Destination', order: 1 })
  await session.persistNow()
  registerLibraryHandlers()
  registerBoxHandlers()
  emit.mockClear()
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
})

afterEach(async () => {
  releaseHeld?.()
  releaseHeld = null
  await session.persistNow({ quitting: true })
  vi.useRealTimers()
  await rm(root, { recursive: true, force: true })
})

describe('main reorder authority across queued and required writes', () => {
  it('captures the submitted source before a queued reorder can start', async () => {
    const a = { ...tape('OrderTapeA', 0, null), archivedAtUtc: null }
    const b = { ...tape('OrderTapeB', 1, null), archivedAtUtc: null }
    const d = tape('OrderTapeD', 5, null)
    await seed([a, b, d])
    const gate = holdNextWrite()
    session.upsertTape({ ...a, title: 'ordinary write ahead' })
    const prior = session.persistNow()
    await gate.held
    const pending = reorder([a.id, b.id])
    await invoke('library:archive', { tapeIds: [a.id] })
    const before = rows()
    try { gate.release(); await prior; await pending } finally { gate.release() }

    expect(rows()).toEqual(before)
    expect(listing(null)).toEqual([[a.id, 4], [d.id, 5]])
    expect(lastReorderRows()).toEqual(session.getTapes().filter(({ id }) => id === a.id || id === b.id))
    await expectCurrentSaved()
  })

  it('keeps a moved-out tape in its normalized destination and emits unchanged source rows too', async () => {
    const a = tape('OrderTapeA', 0)
    const b = tape('OrderTapeB', 1)
    const c = tape('OrderTapeC', 2)
    const d = tape('OrderTapeD', 8, DEST)
    await seed([a, b, c, d])
    const gate = holdNextWrite()
    const pending = reorder([c.id, b.id, a.id])
    await gate.held
    try { await place(a.id, DEST) } finally { gate.release() }
    await pending

    expect(listing(DEST)).toEqual([[a.id, 0], [d.id, 1]])
    expect(listing(SOURCE)).toEqual([[b.id, 1], [c.id, 2]])
    expect(lastReorderRows()).toEqual(session.getTapes().filter(({ id }) => [a.id, b.id, c.id].includes(id)))
    await expectCurrentSaved()
  })

  it('preserves a normalized insertion into the source instead of creating duplicate front orders', async () => {
    const a = tape('OrderTapeA', 0)
    const b = tape('OrderTapeB', 1)
    const c = tape('OrderTapeC', 0, DEST)
    await seed([a, b, c])
    const gate = holdNextWrite()
    const pending = reorder([b.id, a.id])
    await gate.held
    try { await place(c.id, SOURCE) } finally { gate.release() }
    await pending

    expect(listing(SOURCE)).toEqual([[c.id, 0], [a.id, 1], [b.id, 2]])
    expect(lastReorderRows()).toEqual(session.getTapes())
    await expectCurrentSaved()
  })

  it('keeps the current inbox placement when unarchive supersedes a required box reorder', async () => {
    const a = tape('OrderTapeA', 0)
    const b = tape('OrderTapeB', 1)
    const d = { ...tape('OrderTapeD', 5, null), archivedAtUtc: null }
    await seed([a, b, d])
    const gate = holdNextWrite()
    const pending = reorder([b.id, a.id])
    await gate.held
    try { await invoke('library:unarchive', { tapeIds: [a.id] }) } finally { gate.release() }
    await pending

    expect(session.getTape(a.id)).toMatchObject({ archivedAtUtc: null, boxId: null, order: 4 })
    expect(session.getTape(d.id)).toEqual(d)
    expect(listing(SOURCE)).toEqual([[b.id, 1]])
    expect(lastReorderRows()).toEqual(session.getTapes().filter(({ id }) => id === a.id || id === b.id))
    await expectCurrentSaved()
  })

  it('does not revive an older reorder after a tape moves away and back to identical values', async () => {
    const a = tape('OrderTapeA', 0)
    const b = tape('OrderTapeB', 1)
    const c = tape('OrderTapeC', 2)
    await seed([a, b, c])
    const gate = holdNextWrite()
    const pending = reorder([c.id, b.id, a.id])
    await gate.held
    try {
      await place(a.id, DEST)
      await place(a.id, SOURCE)
      expect(rows()).toEqual([[a.id, SOURCE, 0], [b.id, SOURCE, 1], [c.id, SOURCE, 2]])
    } finally { gate.release() }
    await pending

    expect(listing(SOURCE)).toEqual([[a.id, 0], [b.id, 1], [c.id, 2]])
    expect(lastReorderRows()).toEqual(session.getTapes())
    await expectCurrentSaved()
  })

  it.each(['addition', 'removal', 'order edit'] as const)('invalidates source intent on a real %s', async (edit) => {
    const a = tape('OrderTapeA', 0)
    const b = tape('OrderTapeB', 1)
    const c = tape('OrderTapeC', 2)
    await seed([a, b, c])
    const gate = holdNextWrite()
    const pending = reorder([c.id, b.id, a.id])
    await gate.held
    let before: ReturnType<typeof rows>
    try {
      if (edit === 'addition') session.upsertTape(tape('OrderTapeN', -1))
      else if (edit === 'removal') session.removeTapes([b.id])
      else session.upsertTape({ ...a, order: -4 })
      before = rows()
    } finally { gate.release() }
    await pending

    expect(rows()).toEqual(before!)
    expect(lastReorderRows()).toEqual(session.getTapes())
    await expectCurrentSaved()
  })

  it('preserves newer fields while metadata, download state and unrelated list edits leave intent valid', async () => {
    const a = tape('OrderTapeA', 0)
    const b = tape('OrderTapeB', 1)
    const c = tape('OrderTapeC', 2)
    const d = tape('OrderTapeD', 4, DEST)
    await seed([a, b, c, d])
    const gate = holdNextWrite()
    const pending = reorder([c.id, b.id, a.id])
    await gate.held
    try {
      session.upsertTape({ ...a, title: 'new metadata', state: 'downloading', downloadStartedAtUtc: ARCHIVED })
      session.upsertTape({ ...d, order: -3 })
      session.upsertTape(tape('OrderTapeN', -4, DEST))
    } finally { gate.release() }
    await pending

    expect(listing(SOURCE)).toEqual([[c.id, 0], [b.id, 1], [a.id, 2]])
    expect(session.getTape(a.id)).toMatchObject({ title: 'new metadata', state: 'downloading', downloadStartedAtUtc: ARCHIVED })
    expect(listing(DEST)).toEqual([['OrderTapeN', -4], [d.id, -3]])
    expect(lastReorderRows()).toEqual(session.getTapes().filter(({ boxId }) => boxId === SOURCE))
    await expectCurrentSaved()
  })

  it('publishes each still-authorized consecutive success, with the latest success winning', async () => {
    const a = tape('OrderTapeA', 0)
    const b = tape('OrderTapeB', 1)
    const c = tape('OrderTapeC', 2)
    await seed([a, b, c])
    const gate = holdNextWrite()
    const first = session.reorderTapesDurably([c.id, b.id, a.id])
    await gate.held
    const second = session.reorderTapesDurably([b.id, a.id, c.id])
    gate.release()
    const firstRows = await first
    await second

    expect(firstRows.map(({ id, order }) => [id, order])).toEqual([[a.id, 2], [b.id, 1], [c.id, 0]])
    expect(listing(SOURCE)).toEqual([[b.id, 0], [a.id, 1], [c.id, 2]])
    await expectCurrentSaved()
  })

  it('invalidates every outstanding tape intent on organization ABA', async () => {
    const a = tape('OrderTapeA', 0)
    const b = tape('OrderTapeB', 1)
    const c = tape('OrderTapeC', 2)
    await seed([a, b, c])
    const gate = holdNextWrite()
    const first = reorder([c.id, b.id, a.id])
    await gate.held
    const second = reorder([b.id, a.id, c.id])
    const third = reorder([b.id, c.id, a.id])
    try { await place(a.id, DEST); await place(a.id, SOURCE) } finally { gate.release() }
    await Promise.all([first, second, third])

    expect(listing(SOURCE)).toEqual([[a.id, 0], [b.id, 1], [c.id, 2]])
    await expectCurrentSaved()
  })

  it('keeps current metadata scheduled when a newer required reorder cancels its timer and fails', async () => {
    const a = tape('OrderTapeA', 0)
    const b = tape('OrderTapeB', 1)
    const c = tape('OrderTapeC', 2)
    await seed([a, b, c])
    const firstGate = holdNextWrite()
    const first = reorder([b.id, a.id, c.id])
    await firstGate.held
    session.upsertTape({ ...a, title: 'metadata while saving' })
    const second = reorder([b.id, c.id, a.id])
    const rejected = expect(second).rejects.toThrow()
    // Arrange the second write gate before releasing the first physical write.
    const secondGate = holdNextWrite()
    firstGate.release()
    await first
    await secondGate.held
    state.failHeld = true
    secondGate.release()
    await rejected

    expect(session.getTape(a.id)).toMatchObject({ title: 'metadata while saving', order: 1 })
    const scheduled = holdNextWrite()
    await vi.advanceTimersByTimeAsync(500)
    await scheduled.held
    scheduled.release()
    await expectCurrentSaved()
  })

  it('invalidates every outstanding box intent on an actual order ABA', async () => {
    const gate = holdNextWrite()
    const first = invoke('boxes:reorder', { orderedIds: [DEST, SOURCE] })
    await gate.held
    const second = invoke('boxes:reorder', { orderedIds: [DEST, SOURCE] })
    const third = invoke('boxes:reorder', { orderedIds: [DEST, SOURCE] })
    try {
      session.upsertBox({ ...session.getBoxes()[0]!, order: -1 })
      session.upsertBox({ ...session.getBoxes()[0]!, order: 0 })
    } finally { gate.release() }
    await Promise.all([first, second, third])
    expect(session.getBoxes().map(({ id, order }) => [id, order])).toEqual([[SOURCE, 0], [DEST, 1]])
    await expectCurrentSaved()
  })

  it('keeps a newer queued reorder owned when the older required write rejects', async () => {
    const a = tape('OrderTapeA', 0)
    const b = tape('OrderTapeB', 1)
    await seed([a, b])
    const gate = holdNextWrite()
    const first = session.reorderTapesDurably([b.id, a.id])
    const rejected = expect(first).rejects.toThrow('required reorder write failed')
    await gate.held
    state.failHeld = true
    const second = session.reorderTapesDurably([b.id, a.id])
    gate.release()
    await rejected
    await second

    expect(listing(SOURCE)).toEqual([[b.id, 0], [a.id, 1]])
    await expectCurrentSaved()
  })

  it('clears a superseded candidate through the existing scheduled catalog save', async () => {
    const a = tape('OrderTapeA', 0)
    const b = tape('OrderTapeB', 1)
    await seed([a, b])
    const gate = holdNextWrite()
    const pending = reorder([b.id, a.id])
    await gate.held
    try { session.upsertTape(tape('OrderTapeN', -1)) } finally { gate.release() }
    await pending
    // The required candidate really reached disk before it became obsolete.
    const obsolete = SessionSchema.parse(JSON.parse(await readFile(state.catalog, 'utf8')))
    expect(obsolete.tapes.find(({ id }) => id === b.id)?.order).toBe(0)
    expect(session.getTape(b.id)?.order).toBe(1)
    const scheduled = holdNextWrite()
    await vi.advanceTimersByTimeAsync(500)
    await scheduled.held
    scheduled.release()
    // Join the already-started ordinary save without relying on elapsed I/O.
    await session.persistNow()
    await expectCurrentSaved()
  })

  it('invalidates a pending box reorder when deleting and creating through the real handlers', async () => {
    // Deleting the old final box frees order 1 for its replacement. The older
    // candidate would also assign 1 to Source, causing a collision.
    const gate = holdNextWrite()
    const pending = invoke('boxes:reorder', { orderedIds: [DEST, SOURCE] })
    await gate.held
    let created!: { id: string; order: number }
    try {
      await invoke('boxes:delete', { boxId: DEST })
      created = await invoke('boxes:create', { name: 'Replacement' }) as typeof created
      expect(created.order).toBe(1)
    } finally { gate.release() }
    await pending

    expect(session.getBoxes().map(({ id, order }) => [id, order])).toEqual([[SOURCE, 0], [created.id, 1]])
    await expectCurrentSaved()
  })

  it('keeps box rename metadata independent from its pending durable order', async () => {
    const gate = holdNextWrite()
    const pending = invoke('boxes:reorder', { orderedIds: [DEST, SOURCE] })
    await gate.held
    try { await invoke('boxes:rename', { boxId: SOURCE, name: 'New source name' }) } finally { gate.release() }
    await pending

    expect(session.getBoxes()).toEqual([
      { id: SOURCE, name: 'New source name', order: 1 },
      { id: DEST, name: 'Destination', order: 0 },
    ])
    await expectCurrentSaved()
  })
})
