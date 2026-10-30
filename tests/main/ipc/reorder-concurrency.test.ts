vi.mock('@main/ipc/trust', () => ({ isTrustedApplicationSender: () => true }))
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Tape } from '@shared/domain'
import { unwrapIpcReply, type IpcReply } from '@shared/ipc-reply'

const state = vi.hoisted(() => ({
  root: '', holdNext: false,
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
vi.mock('@main/store/config', () => ({ getCollectionDir: () => state.root, getSettings: () => ({ trashOnRemove: false, externalPlayer: '' }) }))
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
      }
      return actual.writeManagedJsonBytes(...args)
    },
  }
})

import { registerCollectionHandlers } from '@main/ipc/collection'
import { registerBoxHandlers } from '@main/ipc/boxes'
import * as session from '@main/store/session'

const SHELVED = '2026-10-11T00:00:00.000Z'
const SOURCE = 'SourceBox1'
const DEST = 'DestBox001'
let root = ''
let releaseHeld: (() => void) | null = null

function tape(id: string, order: number, boxId: string | null = SOURCE): Tape {
  return {
    id, order, sourceUrl: `https://example.test/${id}`, state: 'downloaded', addedAtUtc: SHELVED, addedIndex: 0,
    sourceId: null, extractor: null, title: id, uploader: null, durationSeconds: null, chapterCount: null,
    probedAtUtc: null, filename: null, sidecarFilename: null, thumbnailFilename: null,
    downloadStartedAtUtc: null, downloadedAtUtc: SHELVED, name: null, renamedAtUtc: null,
    shelved: true, boxId, pausedAtUtc: null, failedAtUtc: null, failureCode: null, lastError: null,
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
const listing = (boxId: string | null) => session.getTapes().filter((item) => item.shelved && item.boxId === boxId).sort((a, b) => a.order - b.order).map(({ id, order }) => [id, order])
const lastReorderRows = () => emit.mock.calls.filter(([channel]) => channel === 'tapes:updatedMany').at(-1)![1] as Tape[]

async function expectCurrentSaved() {
  await expect(session.persistNow()).resolves.toBe(true)
  const read = await session.readCollection(state.root)
  if (read.kind !== 'current') throw new Error('expected the current layout')
  const byId = (a: { id: string }, b: { id: string }) => a.id.localeCompare(b.id)
  expect([...read.session.tapes].sort(byId)).toEqual(session.getTapes().map(session.durableTape).sort(byId))
  expect(read.session.boxes).toEqual([...session.getBoxes()].sort((a, b) => a.order - b.order))
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'tapebox-reorder-concurrency-'))
  state.root = root
  state.holdNext = false
  state.release = null
  handlers.clear()
  await session.loadSession()
  session.upsertBox({ id: SOURCE, name: 'Source', order: 0 })
  session.upsertBox({ id: DEST, name: 'Destination', order: 1 })
  await session.persistNow()
  registerCollectionHandlers()
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

// A reorder applies at once and then awaits its save, like every library edit,
// so an edit made while that save runs lands after it and wins.
describe('reorders beside other library edits', () => {
  it('lets a placement made while the reorder saves land after it, without duplicate orders', async () => {
    const a = tape('OrderTapeA', 0)
    const b = tape('OrderTapeB', 1)
    const c = tape('OrderTapeC', 0, DEST)
    await seed([a, b, c])
    const gate = holdNextWrite()
    const pending = reorder([b.id, a.id])
    await gate.held
    try { await place(c.id, SOURCE) } finally { gate.release() }
    await pending

    expect(listing(SOURCE)).toEqual([[c.id, 0], [b.id, 1], [a.id, 2]])
    expect(lastReorderRows()).toEqual(session.getTapes().filter(({ boxId }) => boxId === SOURCE))
    await expectCurrentSaved()
  })

  it('keeps a tape moved out while the reorder saves in its destination', async () => {
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
    expect(listing(SOURCE)).toEqual([[c.id, 0], [b.id, 1]])
    await expectCurrentSaved()
  })

  it('keeps metadata and download state changed while the reorder saves', async () => {
    const a = tape('OrderTapeA', 0)
    const b = tape('OrderTapeB', 1)
    await seed([a, b])
    const gate = holdNextWrite()
    const pending = reorder([b.id, a.id])
    await gate.held
    try {
      session.upsertTape({ ...session.getTape(a.id)!, title: 'new metadata', state: 'downloading', downloadStartedAtUtc: SHELVED })
    } finally { gate.release() }
    await pending

    expect(listing(SOURCE)).toEqual([[b.id, 0], [a.id, 1]])
    expect(session.getTape(a.id)).toMatchObject({ title: 'new metadata', state: 'downloading', downloadStartedAtUtc: SHELVED })
    await expectCurrentSaved()
  })

  it('applies consecutive reorders in the order they arrive', async () => {
    const a = tape('OrderTapeA', 0)
    const b = tape('OrderTapeB', 1)
    const c = tape('OrderTapeC', 2)
    await seed([a, b, c])
    const gate = holdNextWrite()
    const first = reorder([c.id, b.id, a.id])
    await gate.held
    const second = reorder([b.id, a.id, c.id])
    gate.release()
    await Promise.all([first, second])

    expect(listing(SOURCE)).toEqual([[b.id, 0], [a.id, 1], [c.id, 2]])
    await expectCurrentSaved()
  })

  it('keeps a box renamed or added while the box reorder saves', async () => {
    const gate = holdNextWrite()
    const pending = invoke('boxes:reorder', { orderedIds: [DEST, SOURCE] })
    await gate.held
    let created!: { id: string; name: string; order: number }
    try {
      await invoke('boxes:rename', { boxId: SOURCE, name: 'New source name' })
      created = await invoke('boxes:create', { name: 'Replacement' }) as typeof created
    } finally { gate.release() }
    await pending

    expect(session.getBoxes().map(({ id, name, order }) => [id, name, order])).toEqual([
      [SOURCE, 'New source name', 1],
      [DEST, 'Destination', 0],
      [created.id, created.name, 2],
    ])
    await expectCurrentSaved()
  })
})
