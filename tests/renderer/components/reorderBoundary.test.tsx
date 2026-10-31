vi.mock('@main/ipc/trust', () => ({ isTrustedApplicationSender: () => true }))
// @vitest-environment jsdom
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { act, createElement, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Tape } from '@shared/domain'
import { unwrapIpcReply, type IpcReply } from '@shared/ipc-reply'
import { defaultLayout } from '@shared/layout'

const bridge = vi.hoisted(() => ({
  dir: '',
  handlers: new Map<string, (req: unknown) => Promise<unknown>>(),
  listeners: new Map<string, Set<(payload: unknown) => void>>(),
  gates: [] as { started: () => void; release: Promise<void>; fail: boolean }[],
  calls: [] as Promise<unknown>[],
}))
vi.mock('electron', () => ({
  ipcMain: { handle: (channel: string, fn: (event: unknown, req: unknown) => unknown) => {
    bridge.handlers.set(channel, async (req) => unwrapIpcReply(channel, await fn({}, req) as IpcReply<unknown>))
  } },
  shell: { showItemInFolder: vi.fn(), openPath: vi.fn(), trashItem: vi.fn() },
}))
vi.mock('@main/store/config', () => ({ getCollectionDir: () => bridge.dir, getSettings: () => ({ trashOnRemove: false, externalPlayer: '' }) }))
vi.mock('@main/store/backupStore', () => ({ record: vi.fn() }))
vi.mock('@main/io/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }))
vi.mock('@main/ipc/events', () => ({ emit: (channel: string, payload: unknown) => {
  bridge.listeners.get(channel)?.forEach((listener) => listener(payload))
} }))
vi.mock('@main/i18n', () => ({ mainTranslator: () => ({ t: () => 'New Box' }) }))
vi.mock('@main/queue/manager', () => ({ isActive: vi.fn(() => false), cancel: vi.fn() }))
vi.mock('@main/services/ytdlp', () => ({ downloadThumbnail: vi.fn(), probe: vi.fn() }))
vi.mock('@main/services/ffmpeg', () => ({ saveThumbnailJpeg: vi.fn() }))
vi.mock('@main/io/atomic-json', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@main/io/atomic-json')>()
  return { ...actual, writeManagedJsonBytes: async (...args: Parameters<typeof actual.writeManagedJsonBytes>) => {
    const gate = bridge.gates.shift()
    if (gate) {
      gate.started()
      await gate.release
      if (gate.fail) throw new Error('required reorder write failed')
    }
    return actual.writeManagedJsonBytes(...args)
  } }
})
vi.mock('@renderer/ipc/client', () => ({
  ipcInvoke: (channel: string, req: unknown) => {
    const call = bridge.handlers.get(channel)!(req)
    // Observe physical settlement even when the view's result is superseded.
    bridge.calls.push(call.catch(() => undefined))
    return call
  },
  ipcOn: (channel: string, listener: (payload: unknown) => void) => {
    const listeners = bridge.listeners.get(channel) ?? new Set()
    listeners.add(listener)
    bridge.listeners.set(channel, listeners)
    return () => listeners.delete(listener)
  },
}))
vi.mock('@renderer/ipc/log', () => ({ log: { error: vi.fn() } }))
// Exercise real keyboard submissions and callers; drag transport is unused.
vi.mock('@dnd-kit/react', () => ({
  DragDropProvider: ({ children }: { children: ReactNode }) => children,
  useDroppable: () => ({ ref: () => {}, isDropTarget: false }),
}))
vi.mock('@dnd-kit/react/sortable', () => ({ useSortable: () => ({ ref: () => {} }), isSortable: () => false, isSortableOperation: () => false }))
vi.mock('@dnd-kit/dom', () => ({ Accessibility: class {}, PointerActivationConstraints: { Distance: class {} }, PointerSensor: { configure: () => ({}) } }))

import { registerCollectionHandlers } from '@main/ipc/collection'
import { registerBoxHandlers } from '@main/ipc/boxes'
import * as session from '@main/store/session'
import { readCollection } from '@main/store/collection-files'
import { ShelfOrganizer } from '@renderer/components/ShelfOrganizer'
import { startIpcSync, type IpcSync } from '@renderer/ipc/sync'
import { useTapesStore } from '@renderer/store/tapes'
import { useBoxesStore } from '@renderer/store/boxes'
import { useSelectionStore } from '@renderer/store/selection'
import { useFilterStore } from '@renderer/store/filter'
import { useShelfStore } from '@renderer/store/shelf'
import { useLayoutStore } from '@renderer/store/layout'
import { useOrderFailuresStore } from '@renderer/store/orderFailures'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
let directory = ''
let root: Root
let sync: IpcSync
let releases: (() => void)[] = []
const ids = ['OrderItemA', 'OrderItemB', 'OrderItemC']
const date = '2026-10-11T00:00:00.000Z'
function tape(id: string, order: number): Tape {
  return {
    id, order, sourceUrl: `https://example.test/${id}`, state: 'downloaded', addedAtUtc: date,
    sourceId: null, extractor: null, title: id, uploader: null, durationSeconds: null, chapterCount: null,
    probedAtUtc: null, filename: null, sidecarFilename: null, thumbnailFilename: null,
    downloadStartedAtUtc: null, downloadedAtUtc: date, name: null, renamedAtUtc: null,
    addedIndex: 0, shelved: true, boxId: null, pausedAtUtc: null, failedAtUtc: null, failureCode: null, lastError: null,
  }
}
function gate(fail: boolean) {
  let started!: () => void
  let release!: () => void
  const held = new Promise<void>((resolve) => { started = resolve })
  bridge.gates.push({ started, fail, release: new Promise<void>((resolve) => { release = resolve }) })
  releases.push(release)
  return { held, release }
}
async function reorder(label: string) {
  const list = document.querySelector(`[role="listbox"][aria-label="${label}"]`)!
  expect(list).not.toBeNull()
  await act(async () => list.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', ctrlKey: true, shiftKey: true, bubbles: true })))
}
const byId = <T extends { id: string }>(items: T[]) => [...items].sort((a, b) => a.id.localeCompare(b.id))
const identityOrder = (items: { id: string; order: number }[]) => [...items].sort((a, b) => a.order - b.order).map(({ id }) => id)

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'tapebox-reorder-boundary-'))
  bridge.dir = directory
  bridge.handlers.clear(); bridge.listeners.clear(); bridge.gates = []; bridge.calls = []; releases = []
  await session.loadSession()
  registerCollectionHandlers(); registerBoxHandlers()
  useOrderFailuresStore.setState({ boxes: null, shelfTapes: {}, attempts: {}, pending: {} })
  useTapesStore.setState({ tapes: [], progress: {}, stalled: {} })
  useBoxesStore.setState({ boxes: [], editingId: null, draftName: '', pendingRenames: 0 })
  useSelectionStore.setState({ selectedId: ids[0] })
  useShelfStore.setState({ selectedBoxId: null, query: '', pendingSearchFocus: false })
  useFilterStore.setState({ filter: 'shelf' })
  useLayoutStore.getState().setHydratedLayout(defaultLayout)
  HTMLElement.prototype.scrollIntoView = vi.fn()
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
  const host = document.createElement('div'); document.body.append(host); root = createRoot(host)
  sync = startIpcSync()
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
})
afterEach(async () => {
  releases.forEach((release) => release())
  await act(async () => { await Promise.all(bridge.calls); root.unmount() })
  sync.stop()
  await session.persistNow({ quitting: true })
  vi.useRealTimers(); vi.unstubAllGlobals()
  Reflect.deleteProperty(HTMLElement.prototype, 'scrollIntoView')
  document.body.innerHTML = ''
  await rm(directory, { recursive: true, force: true })
})

describe.each(['tapes', 'boxes'] as const)('%s reorder across real callers, IPC, sync and shelf.json', (kind) => {
  it.each([false, true])('keeps the latest order when saves fail, as any collection edit (earlier failure: %s)', async (firstFails) => {
    if (kind === 'tapes') {
      ids.forEach((id, order) => session.upsertTape(tape(id, order)))
      useTapesStore.getState().setAll(session.getTapes())
    } else {
      ids.forEach((id, order) => session.upsertBox({ id, name: id, order }))
      useBoxesStore.getState().setBoxes(session.getBoxes())
      // The box list moves the selected box.
      useShelfStore.getState().selectBox(ids[0])
    }
    await session.persistNow()
    await act(async () => root.render(createElement(ShelfOrganizer)))
    const label = kind === 'tapes' ? 'Box tapes' : 'Boxes'
    const first = gate(firstFails)
    await reorder(label)
    await first.held
    const second = gate(true)
    await reorder(label)
    expect(identityOrder(kind === 'tapes' ? useTapesStore.getState().tapes : useBoxesStore.getState().boxes)).toEqual([ids[1], ids[2], ids[0]])
    await act(async () => { first.release(); await bridge.calls[0] })
    await second.held
    await act(async () => { second.release(); await bridge.calls[1] })

    // A failed save keeps the edit in the collection; the save owner retries and reports it.
    const main = kind === 'tapes' ? session.getTapes() : session.getBoxes()
    const renderer = kind === 'tapes' ? useTapesStore.getState().tapes : useBoxesStore.getState().boxes
    expect(identityOrder(main)).toEqual([ids[1], ids[2], ids[0]])
    expect(renderer).toEqual(main)
    expect(useOrderFailuresStore.getState().pending).toEqual({})
    expect(kind === 'tapes' ? useOrderFailuresStore.getState().shelfTapes.loose ?? null : useOrderFailuresStore.getState().boxes).toBeNull()
    await session.persistNow()
    const saved = await readCollection(directory)
    if (saved.kind !== 'current') throw new Error('expected the current collection layout')
    if (kind === 'tapes') expect(byId(saved.session.tapes)).toEqual(byId(session.getTapes().map(session.durableTape)))
    else expect(byId(saved.session.boxes)).toEqual(byId(session.getBoxes()))
  })
})
