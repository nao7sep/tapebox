import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Box, Tape } from '@shared/domain'

// Which box a tape is filed in, and where it sits inside that box, is the one
// piece of arrangement the user builds by hand — a delete or a drop must never
// scramble it. The session is a working fake so the orders these handlers write
// can be read back; the ordering maths itself (@shared/order) stays real.
const handlers = new Map<string, (req: unknown) => unknown>()
vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, fn: (event: unknown, req: unknown) => unknown) => {
      handlers.set(channel, (req) => fn({}, req))
    },
  },
}))

const state = vi.hoisted(() => ({ boxes: [] as Box[], tapes: [] as Tape[], reordered: [] as Box[] }))
const emit = vi.hoisted(() => vi.fn())
const reorderBoxesDurably = vi.hoisted(() => vi.fn())

vi.mock('@main/store/session', () => ({
  getBoxes: () => state.boxes,
  getTapes: () => state.tapes,
  upsertBox: (box: Box) => {
    state.boxes = [...state.boxes.filter((candidate) => candidate.id !== box.id), box]
  },
  removeBox: (boxId: string) => {
    state.boxes = state.boxes.filter((box) => box.id !== boxId)
  },
  upsertTape: (tape: Tape) => {
    state.tapes = state.tapes.map((candidate) => (candidate.id === tape.id ? tape : candidate))
  },
  reorderBoxesDurably,
}))
vi.mock('@main/ipc/events', () => ({ emit }))
vi.mock('@main/io/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }))

const { registerBoxHandlers } = await import('@main/ipc/boxes')

function makeTape(overrides: Partial<Tape> & { id: string }): Tape {
  return {
    sourceUrl: 'https://example.test/watch', state: 'downloaded',
    addedAtUtc: '2026-01-01T00:00:00.000Z', sourceId: 'source', extractor: 'test',
    title: 'Title', uploader: 'Uploader', durationSeconds: 1, chapterCount: 0,
    probedAtUtc: '2026-01-01T00:00:00.000Z', filename: 'Take.mp4',
    sidecarFilename: 'Take.json', thumbnailFilename: 'Take.jpg',
    downloadStartedAtUtc: null, downloadedAtUtc: '2026-01-01T00:00:00.000Z',
    name: 'Take', renamedAtUtc: null, archivedAtUtc: '2026-01-02T00:00:00.000Z',
    boxId: null, order: 0, pausedAtUtc: null, failedAtUtc: null, lastError: null,
    ...overrides,
  }
}

function invoke<T>(channel: string, req?: unknown): Promise<T> {
  const handler = handlers.get(channel)
  if (!handler) throw new Error(`${channel} was not registered`)
  return Promise.resolve(handler(req) as T)
}

/** The tapes the session holds, top of the list first, as `id@order`. */
function listing(boxId: string | null): string[] {
  return state.tapes
    .filter((tape) => tape.archivedAtUtc !== null && tape.boxId === boxId)
    .sort((a, b) => a.order - b.order)
    .map((tape) => `${tape.id}@${tape.order}`)
}

function emitted(channel: string): unknown[][] {
  return emit.mock.calls.filter((call) => call[0] === channel).map((call) => call.slice(1))
}

beforeEach(() => {
  handlers.clear()
  emit.mockClear()
  reorderBoxesDurably.mockReset()
  state.boxes = [
    { id: 'box-summer', name: 'Summer', order: 0 },
    { id: 'box-winter', name: 'Winter', order: 1 },
  ]
  state.tapes = []
  registerBoxHandlers()
})

describe('listing boxes', () => {
  it('hands back the session list', async () => {
    await expect(invoke('boxes:list')).resolves.toEqual(state.boxes)
  })
})

describe('deleting a box', () => {
  it('drops its tapes into Unboxed as a block, on top, still in the order they held', async () => {
    state.tapes = [
      makeTape({ id: 'unboxed-old', boxId: null, order: 0 }),
      makeTape({ id: 'summer-2nd', boxId: 'box-summer', order: 5 }),
      makeTape({ id: 'summer-1st', boxId: 'box-summer', order: 1 }),
      makeTape({ id: 'winter-kept', boxId: 'box-winter', order: 0 }),
    ]

    await invoke('boxes:delete', { boxId: 'box-summer' })

    expect(state.boxes.map((box) => box.id)).toEqual(['box-winter'])
    expect(listing(null)).toEqual(['summer-1st@-2', 'summer-2nd@-1', 'unboxed-old@0'])
    expect(listing('box-winter'), 'another box is untouched').toEqual(['winter-kept@0'])
    expect(emitted('boxes:changed')).toHaveLength(1)
    expect(emitted('tapes:updatedMany')).toEqual([[[
      expect.objectContaining({ id: 'summer-1st', boxId: null, order: -2 }),
      expect.objectContaining({ id: 'summer-2nd', boxId: null, order: -1 }),
    ]]])
  })

  it('leaves inbox tapes out of the reshuffle, though they too have no box', async () => {
    state.tapes = [
      makeTape({ id: 'in-the-inbox', archivedAtUtc: null, boxId: null, order: 0 }),
      makeTape({ id: 'summer-only', boxId: 'box-summer', order: 3 }),
    ]

    await invoke('boxes:delete', { boxId: 'box-summer' })

    // The inbox tape's order is not consulted, so the orphan block starts at 0.
    expect(listing(null)).toEqual(['summer-only@0'])
    expect(state.tapes.find((tape) => tape.id === 'in-the-inbox')).toMatchObject({ order: 0, archivedAtUtc: null })
  })

  it('announces the box is gone but touches no tape when the box held none', async () => {
    state.tapes = [makeTape({ id: 'winter-kept', boxId: 'box-winter', order: 0 })]

    await invoke('boxes:delete', { boxId: 'box-summer' })

    expect(emitted('boxes:changed')).toHaveLength(1)
    expect(emitted('tapes:updatedMany')).toEqual([])
  })
})

describe('reordering boxes', () => {
  it('announces the new order the session committed', async () => {
    reorderBoxesDurably.mockResolvedValue([{ id: 'box-winter', name: 'Winter', order: 0 }])

    await invoke('boxes:reorder', { orderedIds: ['box-winter', 'box-summer'] })

    expect(reorderBoxesDurably).toHaveBeenCalledExactlyOnceWith(['box-winter', 'box-summer'])
    expect(emitted('boxes:changed')).toHaveLength(1)
  })

  it('stays quiet when the session found nothing to change', async () => {
    reorderBoxesDurably.mockResolvedValue([])

    await invoke('boxes:reorder', { orderedIds: ['box-summer', 'box-winter'] })

    expect(emitted('boxes:changed')).toEqual([])
  })
})

describe('filing tapes into a box', () => {
  it('puts the dropped tapes on top in the order they were dropped, above what was already there', async () => {
    state.tapes = [
      makeTape({ id: 'winter-1st', boxId: 'box-winter', order: 0 }),
      makeTape({ id: 'winter-2nd', boxId: 'box-winter', order: 1 }),
      makeTape({ id: 'unboxed-a', boxId: null, order: 4 }),
      makeTape({ id: 'unboxed-b', boxId: null, order: 9 }),
    ]

    await invoke('boxes:place', { tapeIds: ['unboxed-b', 'unboxed-a'], boxId: 'box-winter' })

    expect(listing('box-winter')).toEqual(['unboxed-b@0', 'unboxed-a@1', 'winter-1st@2', 'winter-2nd@3'])
    expect(listing(null)).toEqual([])
    expect(emitted('tapes:updatedMany')).toHaveLength(1)
  })

  it('files tapes back into Unboxed without disturbing the inbox', async () => {
    state.tapes = [
      makeTape({ id: 'in-the-inbox', archivedAtUtc: null, boxId: null, order: 0 }),
      makeTape({ id: 'unboxed-old', boxId: null, order: 0 }),
      makeTape({ id: 'summer-tape', boxId: 'box-summer', order: 0 }),
    ]

    await invoke('boxes:place', { tapeIds: ['summer-tape'], boxId: null })

    expect(listing(null)).toEqual(['summer-tape@0', 'unboxed-old@1'])
    expect(state.tapes.find((tape) => tape.id === 'in-the-inbox')).toMatchObject({ boxId: null, order: 0 })
  })

  it('ignores ids the session no longer holds', async () => {
    state.tapes = [makeTape({ id: 'unboxed-a', boxId: null, order: 3 })]

    await invoke('boxes:place', { tapeIds: ['gone-already', 'unboxed-a'], boxId: 'box-summer' })

    expect(listing('box-summer')).toEqual(['unboxed-a@0'])
  })

  it('reports only the tapes whose filing actually changed', async () => {
    state.tapes = [
      makeTape({ id: 'already-first', boxId: 'box-summer', order: 0 }),
      makeTape({ id: 'already-second', boxId: 'box-summer', order: 1 }),
    ]

    await invoke('boxes:place', { tapeIds: ['already-first'], boxId: 'box-summer' })

    expect(emitted('tapes:updatedMany'), 'a drop that changes nothing is not announced').toEqual([])
  })
})
