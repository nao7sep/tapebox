import { describe, expect, it } from 'vitest'
import { TapeSchema, type Tape } from '@shared/domain'
import { visibleTapes } from '@renderer/lib/tapeOrder'

/** A complete valid Tape from a few overrides (the schema is authoritative — no
 *  defaults fill missing fields, so every field is supplied here). */
function tape(overrides: Partial<Tape> & { id: string }): Tape {
  return TapeSchema.parse({
    sourceUrl: `https://example.com/watch?v=${overrides.id}`,
    state: 'downloaded',
    addedAtUtc: '2024-01-01T00:00:00.000Z',
    sourceId: overrides.id,
    extractor: null,
    title: overrides.id,
    uploader: null,
    durationSeconds: null,
    chapterCount: 0,
    probedAtUtc: null,
    filename: `${overrides.id}.mp4`,
    sidecarFilename: `${overrides.id}.json`,
    thumbnailFilename: null,
    downloadStartedAtUtc: null,
    downloadedAtUtc: null,
    name: null,
    renamedAtUtc: null,
    archivedAtUtc: null,
    boxId: null,
    order: 0,
    pausedAtUtc: null,
    failedAtUtc: null,
    lastError: null,
    ...overrides,
  })
}

const ids = (tapes: Tape[]) => tapes.map((t) => t.id)

describe('visibleTapes — inbox', () => {
  it('orders by manual order ascending (top first)', () => {
    const tapes = [tape({ id: 'b', order: 1 }), tape({ id: 'c', order: 2 }), tape({ id: 'a', order: 0 })]
    expect(ids(visibleTapes(tapes, 'inbox'))).toEqual(['a', 'b', 'c'])
  })

  it('breaks order ties by recency, newest first', () => {
    const tapes = [
      tape({ id: 'old', order: 0, addedAtUtc: '2024-01-01T00:00:00.000Z' }),
      tape({ id: 'new', order: 0, addedAtUtc: '2024-06-01T00:00:00.000Z' }),
    ]
    expect(ids(visibleTapes(tapes, 'inbox'))).toEqual(['new', 'old'])
  })

  it('keeps a failed tape in its manual position instead of surfacing it', () => {
    const tapes = [
      tape({ id: 'top', order: 0 }),
      tape({ id: 'boom', order: 1, state: 'failed', failedAtUtc: '2024-09-09T00:00:00.000Z' }),
      tape({ id: 'bottom', order: 2 }),
    ]
    expect(ids(visibleTapes(tapes, 'inbox'))).toEqual(['top', 'boom', 'bottom'])
  })

  it('excludes archived tapes', () => {
    const tapes = [tape({ id: 'a', order: 0 }), tape({ id: 'z', order: 1, archivedAtUtc: '2024-01-01T00:00:00.000Z' })]
    expect(ids(visibleTapes(tapes, 'inbox'))).toEqual(['a'])
  })
})

describe('visibleTapes — archived', () => {
  const archived = (over: Partial<Tape> & { id: string }) =>
    tape({ archivedAtUtc: '2024-01-01T00:00:00.000Z', ...over })

  it('shows one box at a time in manual order', () => {
    const tapes = [
      archived({ id: 'unboxed', boxId: null, order: 0 }),
      archived({ id: 'b2', boxId: 'box1', order: 1 }),
      archived({ id: 'b1', boxId: 'box1', order: 0 }),
    ]
    expect(ids(visibleTapes(tapes, 'archived', 'box1'))).toEqual(['b1', 'b2'])
    expect(ids(visibleTapes(tapes, 'archived', null))).toEqual(['unboxed'])
  })

  it('search orders by box (then within-box order), spanning all boxes', () => {
    const boxes = [
      { id: 'box1', name: 'A', order: 0 },
      { id: 'box2', name: 'B', order: 1 },
    ]
    const tapes = [
      archived({ id: 'b', title: 'cat meme', boxId: 'box2', order: 0, downloadedAtUtc: '2024-05-01T00:00:00.000Z' }),
      archived({ id: 'a', title: 'cat video', boxId: 'box1', order: 0, downloadedAtUtc: '2024-01-01T00:00:00.000Z' }),
      archived({ id: 'c', title: 'dog', boxId: 'box1', order: 1 }),
    ]
    // Box A (order 0) precedes box B (order 1) even though B's match is newer; the
    // selected box is ignored (search spans all); 'dog' is filtered out.
    expect(ids(visibleTapes(tapes, 'archived', 'box1', 'cat', boxes))).toEqual(['a', 'b'])
  })

  it('search puts Unboxed first, then each box in its own manual order', () => {
    const boxes = [{ id: 'box1', name: 'A', order: 0 }]
    const tapes = [
      archived({ id: 'a1', title: 'x one', boxId: 'box1', order: 0 }),
      archived({ id: 'unboxed', title: 'x unboxed', boxId: null, order: 0 }),
      archived({ id: 'a2', title: 'x two', boxId: 'box1', order: 1 }),
    ]
    expect(ids(visibleTapes(tapes, 'archived', null, 'x', boxes))).toEqual(['unboxed', 'a1', 'a2'])
  })
})
