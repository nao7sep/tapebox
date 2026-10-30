// @vitest-environment jsdom
import { act, createElement, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TapeSchema, type Tape } from '@shared/domain'
import { SHELF_SEARCH_BOX_HEIGHT, defaultLayout } from '@shared/layout'

const { ipcInvoke, logError } = vi.hoisted(() => ({ ipcInvoke: vi.fn(), logError: vi.fn() }))
vi.mock('@renderer/ipc/client', () => ({ ipcInvoke, ipcOn: () => () => {} }))
vi.mock('@renderer/ipc/log', () => ({ log: { error: logError } }))
// Transport is not involved in these keyboard submissions. Keep the actual
// list composition, keyboard hooks, settlement callers, and stores in the test.
vi.mock('@dnd-kit/react', () => ({
  DragDropProvider: ({ children }: { children: ReactNode }) => children,
  useDroppable: () => ({ ref: () => {}, isDropTarget: false }),
}))
vi.mock('@dnd-kit/react/sortable', () => ({
  useSortable: () => ({ ref: () => {} }),
  isSortable: () => false,
  isSortableOperation: () => false,
}))
vi.mock('@dnd-kit/dom', () => ({
  Accessibility: class {},
  PointerActivationConstraints: { Distance: class {} },
  PointerSensor: { configure: () => ({}) },
}))

import { TapeList } from '@renderer/components/TapeList'
import { ShelfOrganizer } from '@renderer/components/ShelfOrganizer'
import { moveTapeToBox } from '@renderer/lib/tapeActions'
import { useTapesStore } from '@renderer/store/tapes'
import { useBoxesStore } from '@renderer/store/boxes'
import { useSelectionStore } from '@renderer/store/selection'
import { useFilterStore } from '@renderer/store/filter'
import { useShelfStore } from '@renderer/store/shelf'
import { useLayoutStore } from '@renderer/store/layout'
import { useOrderFailuresStore } from '@renderer/store/orderFailures'
import { useTapeActionResultsStore } from '@renderer/store/tapeActionResults'
import { useBoxActionResultsStore } from '@renderer/store/boxActionResults'
import { message } from '@shared/i18n/translate'
import { inEnglish } from '../../helpers/i18n'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let root: Root

function tape(id: string, order: number): Tape {
  return TapeSchema.parse({
    id,
    sourceUrl: 'https://example.com/video',
    state: 'downloading',
    addedAtUtc: '2026-10-01T00:00:00.000Z',
    sourceId: null,
    extractor: null,
    title: id,
    uploader: null,
    durationSeconds: null,
    chapterCount: null,
    probedAtUtc: null,
    filename: null,
    sidecarFilename: null,
    thumbnailFilename: null,
    downloadStartedAtUtc: '2026-10-01T00:00:01.000Z',
    downloadedAtUtc: null,
    name: null,
    renamedAtUtc: null,
    addedIndex: 0,
    shelved: true,
    boxId: null,
    order,
    pausedAtUtc: null,
    failedAtUtc: null,
    failureCode: null,
    lastError: null,
  })
}

function pendingWrite() {
  let reject!: (reason: Error) => void
  let resolve!: () => void
  const promise = new Promise<void>((succeed, fail) => { resolve = succeed; reject = fail })
  ipcInvoke.mockReturnValueOnce(promise)
  return { reject, resolve }
}

function currentTape(id: string): Tape {
  return useTapesStore.getState().tapes.find((candidate) => candidate.id === id)!
}

async function mountTapes(boxId: string | null = null) {
  useFilterStore.setState({ filter: 'shelf' })
  useTapesStore.setState({ tapes: [tape('TapeFirst1', 10), tape('TapeSecond', 20), tape('TapeThird1', 30)].map((item) => ({ ...item, boxId })) })
  useShelfStore.getState().selectBox(boxId)
  useSelectionStore.setState({ selectedId: 'TapeFirst1' })
  await act(async () => root.render(createElement(ShelfOrganizer)))
}

async function reorder(label: string, key = 'ArrowDown') {
  const list = document.querySelector(`[role="listbox"][aria-label="${label}"]`)!
  expect(list).not.toBeNull()
  await act(async () => list.dispatchEvent(new KeyboardEvent('keydown', { key, ctrlKey: true, shiftKey: true, bubbles: true })))
}

beforeEach(() => {
  ipcInvoke.mockReset().mockResolvedValue(undefined)
  logError.mockReset()
  HTMLElement.prototype.scrollIntoView = vi.fn()
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
  useTapesStore.setState({ tapes: [], progress: {}, stalled: {} })
  useBoxesStore.setState({ boxes: [], editingId: null, draftName: '', pendingRenames: 0 })
  useSelectionStore.setState({ selectedId: null })
  useShelfStore.setState({ selectedBoxId: null, query: '', pendingSearchFocus: false })
  useLayoutStore.getState().setHydratedLayout(defaultLayout)
  useOrderFailuresStore.setState({ boxes: null, shelfTapes: {}, attempts: {}, pending: {} })
  useTapeActionResultsStore.setState({ byTape: {} })
  useBoxActionResultsStore.setState({ results: {} })
  const host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})

afterEach(async () => {
  await act(async () => root.unmount())
  vi.unstubAllGlobals()
  Reflect.deleteProperty(HTMLElement.prototype, 'scrollIntoView')
  document.body.innerHTML = ''
})

// The Inbox has no chosen order, so only a Shelf list settles a tape reorder.
describe('Inbox tape list', () => {
  it('offers no keyboard reorder', async () => {
    useFilterStore.setState({ filter: 'inbox' })
    useTapesStore.setState({ tapes: [tape('TapeFirst1', 0), tape('TapeSecond', 0)].map((item) => ({ ...item, shelved: false })) })
    useSelectionStore.setState({ selectedId: 'TapeFirst1' })
    await act(async () => root.render(createElement(TapeList)))
    const before = useTapesStore.getState().tapes
    await reorder('Tapes')

    expect(ipcInvoke).not.toHaveBeenCalled()
    expect(useTapesStore.getState().tapes).toBe(before)
    expect(useOrderFailuresStore.getState().pending).toEqual({})
  })
})

describe('Shelf tape reorder settlement through its list', () => {
  const label = 'Box tapes'
  it('restores only order after download and metadata updates arrive during the rejected save', async () => {
    await mountTapes()
    const pending = pendingWrite()
    await reorder(label)
    expect(ipcInvoke).toHaveBeenCalledWith('tapes:reorder', { orderedIds: ['TapeSecond', 'TapeFirst1', 'TapeThird1'] })
    expect(currentTape('TapeFirst1').order).toBe(1)

    const downloaded = {
      ...currentTape('TapeFirst1'),
      state: 'downloaded' as const,
      downloadedAtUtc: '2026-10-01T00:00:02.000Z',
      filename: 'finished.mp4',
      sidecarFilename: 'finished.json',
      thumbnailFilename: 'finished.jpg',
      title: 'Updated title',
      name: 'renamed-video',
      renamedAtUtc: '2026-10-01T00:00:03.000Z',
    }
    await act(async () => useTapesStore.getState().upsert(downloaded))
    await act(async () => pending.reject(new Error('EACCES /private/tmp/ORDER_SENTINEL')))

    expect(currentTape('TapeFirst1')).toEqual({ ...downloaded, order: 10 })
    expect(currentTape('TapeSecond').order).toBe(20)
    const result = useOrderFailuresStore.getState().shelfTapes.unboxed
    expect(inEnglish(result)).toContain('order')
    expect(inEnglish(result)).not.toMatch(/EACCES|private\/tmp|ORDER_SENTINEL/)
    expect(JSON.stringify(logError.mock.calls)).toContain('ORDER_SENTINEL')
    expect(document.body.textContent).toContain('Updated title')
  })

  it('restores surviving orders without resurrecting a deleted tape or dropping an added tape', async () => {
    await mountTapes()
    const pending = pendingWrite()
    await reorder(label)
    const added = tape('TapeAdded1', -1)
    await act(async () => {
      useTapesStore.getState().removeMany(['TapeThird1'])
      useTapesStore.getState().upsert(added)
    })
    await act(async () => pending.reject(new Error('reorder rejected')))

    expect(useTapesStore.getState().tapes.map(({ id, order }) => ({ id, order }))).toEqual([
      { id: 'TapeFirst1', order: 10 },
      { id: 'TapeSecond', order: 20 },
      { id: added.id, order: -1 },
    ])
    expect(currentTape(added.id)).toEqual(added)
  })

  it('settles rejected order after a whole downloaded main row restores one old order', async () => {
    await mountTapes()
    const before = currentTape('TapeFirst1')
    const pending = pendingWrite()
    await reorder(label)
    // Main publishes the complete download row while the order write is still
    // pending, so it carries the old main order rather than the optimistic one.
    const downloaded = {
      ...before,
      state: 'downloaded' as const,
      title: 'Downloaded main title',
      downloadedAtUtc: '2026-10-01T00:00:02.000Z',
      filename: 'completed.mp4',
      sidecarFilename: 'completed.json',
    }
    await act(async () => useTapesStore.getState().upsert(downloaded))
    expect(currentTape('TapeFirst1').order).toBe(10)
    expect(currentTape('TapeSecond').order).toBe(0)
    await act(async () => pending.reject(new Error('EACCES /private/tmp/WHOLE_ROW_SENTINEL')))

    expect(currentTape('TapeFirst1')).toEqual(downloaded)
    expect(currentTape('TapeSecond').order).toBe(20)
    expect(currentTape('TapeThird1').order).toBe(30)
    const result = useOrderFailuresStore.getState().shelfTapes.unboxed
    expect(inEnglish(result)).toContain('order')
    expect(inEnglish(result)).not.toContain('WHOLE_ROW_SENTINEL')
    expect(JSON.stringify(logError.mock.calls)).toContain('WHOLE_ROW_SENTINEL')
  })

  it('preserves a moved main row whose destination order equals its rejected source order', async () => {
    const sourceBoxId = 'BoxSource1'
    const destinationBoxId = 'BoxTarget1'
    useBoxesStore.getState().setBoxes([
      { id: 'BoxSource1', name: 'Source box', order: 0 },
      { id: 'BoxTarget1', name: 'Target box', order: 1 },
    ])
    await mountTapes(sourceBoxId)
    const moving = { ...currentTape('TapeSecond'), state: 'downloaded' as const, filename: 'moving.mp4', sidecarFilename: 'moving.json' }
    const destinationMember = { ...tape('TapeTarget', 1), boxId: destinationBoxId }
    await act(async () => useTapesStore.getState().upsertMany([moving, destinationMember]))
    const pending = pendingWrite()
    await reorder(label)
    expect(currentTape(moving.id).order).toBe(0)

    await act(async () => moveTapeToBox(currentTape(moving.id), destinationBoxId, 'list'))
    expect(ipcInvoke).toHaveBeenCalledWith('boxes:place', { tapeIds: [moving.id], boxId: destinationBoxId })
    // Main's placement event carries its full row in the new list. The
    // new list's front order happens to equal the source reorder's submitted 0.
    const moved = { ...moving, boxId: destinationBoxId, order: 0, title: 'Moved main title' }
    await act(async () => useTapesStore.getState().upsert(moved))
    await act(async () => pending.reject(new Error('source order rejected after move')))

    expect(currentTape(moving.id)).toEqual(moved)
    expect(currentTape('TapeFirst1').order).toBe(10)
    expect(currentTape('TapeThird1').order).toBe(30)
    expect(currentTape(destinationMember.id)).toEqual(destinationMember)
    const result = useOrderFailuresStore.getState().shelfTapes[`box:${sourceBoxId}`]
    expect(inEnglish(result)).toContain('order')
  })

  it('ignores an older rejection after a remounted list submits the same numeric order', async () => {
    await mountTapes()
    const before = useTapesStore.getState().tapes
    const older = pendingWrite()
    await reorder(label)
    await act(async () => root.render(null))
    // An authoritative refresh restores the saved values while the view is away.
    useTapesStore.getState().setAll(before)
    await act(async () => root.render(createElement(ShelfOrganizer)))
    const newer = pendingWrite()
    await reorder(label)
    const latest = useTapesStore.getState().tapes
    await act(async () => older.reject(new Error('superseded remount order rejected')))

    expect(useOrderFailuresStore.getState().pending['shelf:unboxed']?.active.size).toBe(1)

    expect(useTapesStore.getState().tapes).toBe(latest)
    const result = useOrderFailuresStore.getState().shelfTapes.unboxed
    expect(result ?? null).toBeNull()
    await act(async () => newer.resolve())
    expect(useOrderFailuresStore.getState().pending).toEqual({})
  })

  it('keeps a newer reorder and its retained result when the older request rejects', async () => {
    await mountTapes()
    const older = pendingWrite()
    await reorder(label)
    const newer = pendingWrite()
    await reorder(label)
    const latest = useTapesStore.getState().tapes
    const retained = message('tapes.orderSaveFailed')
    await act(async () => useOrderFailuresStore.getState().setShelfTapes('unboxed', retained))
    await act(async () => older.reject(new Error('older reorder rejected')))

    expect(useTapesStore.getState().tapes).toEqual(latest)
    const result = useOrderFailuresStore.getState().shelfTapes.unboxed
    expect(result).toEqual(retained)
    await act(async () => newer.resolve())
    const cleared = useOrderFailuresStore.getState().shelfTapes.unboxed
    expect(cleared ?? null).toBeNull()
  })

  it('keeps the authoritative tape objects received before successful settlement', async () => {
    await mountTapes()
    const pending = pendingWrite()
    await reorder(label)
    const confirmed = useTapesStore.getState().tapes.map((item) => ({ ...item, title: 'Main title', order: item.order - 10 }))
    await act(async () => useTapesStore.getState().setAll(confirmed))
    await act(async () => pending.resolve())

    expect(useTapesStore.getState().tapes).toBe(confirmed)
  })
})

// The boxes height is clamped against the search box's reserved height, which the
// search box takes.
describe('the Shelf search box', () => {
  it('takes the height the boxes clamp reserves for it', async () => {
    await mountTapes()
    const search = document.querySelector<HTMLInputElement>('input')!
    expect(search.parentElement!.style.height).toBe(`${SHELF_SEARCH_BOX_HEIGHT}px`)
  })
})

describe('box reorder settlement through ShelfOrganizer', () => {
  async function mountBoxes() {
    useFilterStore.setState({ filter: 'shelf' })
    useBoxesStore.getState().setBoxes([
      { id: 'BoxFirst01', name: 'First box', order: 10 },
      { id: 'BoxSecond1', name: 'Second box', order: 20 },
      { id: 'BoxThird01', name: 'Third box', order: 30 },
    ])
    useShelfStore.getState().selectBox('BoxFirst01')
    await act(async () => root.render(createElement(ShelfOrganizer)))
  }

  it('preserves a live rename and an added box while restoring rejected order', async () => {
    await mountBoxes()
    const pending = pendingWrite()
    await reorder('Boxes')
    expect(ipcInvoke).toHaveBeenCalledWith('boxes:reorder', { orderedIds: ['BoxSecond1', 'BoxFirst01', 'BoxThird01'] })
    const added = { id: 'BoxAdded01', name: 'Added box', order: -1 }
    await act(async () => useBoxesStore.getState().setBoxes([
      ...useBoxesStore.getState().boxes.map((box) => box.id === 'BoxFirst01' ? { ...box, name: 'Renamed box' } : box),
      added,
    ]))
    await act(async () => pending.reject(new Error('EACCES /private/tmp/BOX_ORDER_SENTINEL')))

    expect(useBoxesStore.getState().boxes).toEqual([
      { id: 'BoxFirst01', name: 'Renamed box', order: 10 },
      { id: 'BoxSecond1', name: 'Second box', order: 20 },
      { id: 'BoxThird01', name: 'Third box', order: 30 },
      added,
    ])
    expect(inEnglish(useOrderFailuresStore.getState().boxes)).toContain('order')
    expect(inEnglish(useOrderFailuresStore.getState().boxes)).not.toContain('BOX_ORDER_SENTINEL')
    expect(JSON.stringify(logError.mock.calls)).toContain('BOX_ORDER_SENTINEL')
  })

  it('restores only surviving boxes when another box was deleted during the save', async () => {
    await mountBoxes()
    const pending = pendingWrite()
    await reorder('Boxes')
    await act(async () => useBoxesStore.getState().setBoxes(useBoxesStore.getState().boxes.filter((box) => box.id !== 'BoxThird01')))
    await act(async () => pending.reject(new Error('box reorder rejected')))

    expect(useBoxesStore.getState().boxes).toEqual([
      { id: 'BoxFirst01', name: 'First box', order: 10 },
      { id: 'BoxSecond1', name: 'Second box', order: 20 },
    ])
  })

  it('keeps a newer box order and result after the older request rejects', async () => {
    await mountBoxes()
    const older = pendingWrite()
    await reorder('Boxes')
    const newer = pendingWrite()
    await reorder('Boxes')
    const latest = useBoxesStore.getState().boxes
    const retained = message('shelf.boxOrderSaveFailed')
    await act(async () => useOrderFailuresStore.getState().setBoxes(retained))
    await act(async () => older.reject(new Error('older box order rejected')))

    expect(useBoxesStore.getState().boxes).toBe(latest)
    expect(useOrderFailuresStore.getState().boxes).toEqual(retained)
    await act(async () => newer.resolve())
    expect(useOrderFailuresStore.getState().boxes).toBeNull()
  })

  it('ignores a superseded box reorder across organizer remounts with the same numeric order', async () => {
    await mountBoxes()
    const before = useBoxesStore.getState().boxes
    const older = pendingWrite()
    await reorder('Boxes')
    await act(async () => root.render(null))
    useBoxesStore.getState().setBoxes(before)
    await act(async () => root.render(createElement(ShelfOrganizer)))
    const newer = pendingWrite()
    await reorder('Boxes')
    const latest = useBoxesStore.getState().boxes
    await act(async () => older.reject(new Error('superseded remount box order rejected')))

    expect(useOrderFailuresStore.getState().pending.boxes?.active.size).toBe(1)

    expect(useBoxesStore.getState().boxes).toBe(latest)
    expect(useOrderFailuresStore.getState().boxes).toBeNull()
    await act(async () => newer.resolve())
    expect(useOrderFailuresStore.getState().pending).toEqual({})
  })
})
