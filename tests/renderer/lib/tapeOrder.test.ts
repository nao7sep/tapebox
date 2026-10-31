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
    addedIndex: 0,
    shelved: false,
    boxId: null,
    order: 0,
    pausedAtUtc: null,
    failedAtUtc: null,
    failureCode: null,
    lastError: null,
    ...overrides,
  })
}

const ids = (tapes: Tape[]) => tapes.map((t) => t.id)

describe('visibleTapes — inbox', () => {
  it('puts the newest added tape first', () => {
    const tapes = [
      tape({ id: 'old_______', addedAtUtc: '2024-01-01T00:00:00.000Z' }),
      tape({ id: 'new_______', addedAtUtc: '2024-06-01T00:00:00.000Z' }),
      tape({ id: 'mid_______', addedAtUtc: '2024-03-01T00:00:00.000Z' }),
    ]
    expect(ids(visibleTapes(tapes, 'inbox'))).toEqual(['new_______', 'mid_______', 'old_______'])
  })

  it('keeps a batch added together in its pasted order, first URL on top', () => {
    const batch = '2024-06-01T00:00:00.000Z'
    const tapes = [
      tape({ id: 'cccccccccc', addedAtUtc: batch, addedIndex: 2 }),
      tape({ id: 'earlier___', addedAtUtc: '2024-01-01T00:00:00.000Z' }),
      tape({ id: 'aaaaaaaaaa', addedAtUtc: batch, addedIndex: 1 }),
      tape({ id: 'bbbbbbbbbb', addedAtUtc: batch, addedIndex: 0 }),
    ]
    expect(ids(visibleTapes(tapes, 'inbox'))).toEqual(['bbbbbbbbbb', 'aaaaaaaaaa', 'cccccccccc', 'earlier___'])
  })

  it('breaks remaining ties by id', () => {
    const tapes = [tape({ id: 'bbbbbbbbbb' }), tape({ id: 'aaaaaaaaaa' })]
    expect(ids(visibleTapes(tapes, 'inbox'))).toEqual(['aaaaaaaaaa', 'bbbbbbbbbb'])
  })

  it('ignores order, download time and state', () => {
    const tapes = [
      tape({ id: 'first_____', addedAtUtc: '2024-06-01T00:00:00.000Z', order: 5 }),
      tape({ id: 'boom______', addedAtUtc: '2024-03-01T00:00:00.000Z', order: -3, state: 'failed', failedAtUtc: '2024-09-09T00:00:00.000Z' }),
      tape({ id: 'last______', addedAtUtc: '2024-01-01T00:00:00.000Z', order: 0, downloadedAtUtc: '2024-12-01T00:00:00.000Z' }),
    ]
    expect(ids(visibleTapes(tapes, 'inbox'))).toEqual(['first_____', 'boom______', 'last______'])
  })

  it('excludes shelved tapes', () => {
    const tapes = [tape({ id: 'aaaaaaaaaa' }), tape({ id: 'zzzzzzzzzz', order: 1, shelved: true })]
    expect(ids(visibleTapes(tapes, 'inbox'))).toEqual(['aaaaaaaaaa'])
  })
})

describe('visibleTapes — shelved', () => {
  const shelved = (over: Partial<Tape> & { id: string }) =>
    tape({ shelved: true, ...over })

  it('shows one box at a time in manual order', () => {
    const tapes = [
      shelved({ id: 'loose_____', boxId: null, order: 0 }),
      shelved({ id: 'b2________', boxId: 'box1', order: 1 }),
      shelved({ id: 'b1________', boxId: 'box1', order: 0 }),
    ]
    expect(ids(visibleTapes(tapes, 'shelf', 'box1'))).toEqual(['b1________', 'b2________'])
    expect(ids(visibleTapes(tapes, 'shelf', null))).toEqual(['loose_____'])
  })

  it('search orders by box (then within-box order), spanning all boxes', () => {
    const boxes = [
      { id: 'box1', name: 'A', order: 0 },
      { id: 'box2', name: 'B', order: 1 },
    ]
    const tapes = [
      shelved({ id: 'bbbbbbbbbb', title: 'cat meme', boxId: 'box2', order: 0, downloadedAtUtc: '2024-05-01T00:00:00.000Z' }),
      shelved({ id: 'aaaaaaaaaa', title: 'cat video', boxId: 'box1', order: 0, downloadedAtUtc: '2024-01-01T00:00:00.000Z' }),
      shelved({ id: 'cccccccccc', title: 'dog', boxId: 'box1', order: 1 }),
    ]
    // Box A (order 0) precedes box B (order 1) even though B's match is newer; the
    // selected box is ignored (search spans all); 'dog' is filtered out.
    expect(ids(visibleTapes(tapes, 'shelf', 'box1', 'cat', boxes))).toEqual(['aaaaaaaaaa', 'bbbbbbbbbb'])
  })

  it('search puts Loose tapes first, then each box in its own manual order', () => {
    const boxes = [{ id: 'box1', name: 'A', order: 0 }]
    const tapes = [
      shelved({ id: 'a1________', title: 'x one', boxId: 'box1', order: 0 }),
      shelved({ id: 'loose_____', title: 'x loose', boxId: null, order: 0 }),
      shelved({ id: 'a2________', title: 'x two', boxId: 'box1', order: 1 }),
    ]
    expect(ids(visibleTapes(tapes, 'shelf', null, 'x', boxes))).toEqual(['loose_____', 'a1________', 'a2________'])
  })
})
