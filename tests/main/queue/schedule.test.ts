import { describe, it, expect } from 'vitest'

import { selectTapesToStart } from '@main/queue/schedule'
import type { Tape } from '@shared/domain'


function tape(id: string, state: Tape['state'], overrides: Partial<Tape> = {}): Tape {
  return {
    id,
    sourceUrl: `http://example.com/${id}`,
    state,
    addedAtUtc: '2026-01-01T00:00:00.000Z',
    addedIndex: 0,
    sourceId: null,
    extractor: null,
    title: null,
    uploader: null,
    durationSeconds: null,
    chapterCount: 0,
    probedAtUtc: null,
    filename: null,
    sidecarFilename: null,
    thumbnailFilename: null,
    downloadStartedAtUtc: null,
    downloadedAtUtc: null,
    name: null,
    renamedAtUtc: null,
    shelved: false,
    boxId: null,
    order: 0,
    pausedAtUtc: null,
    failedAtUtc: null,
    failureCode: null,
    lastError: null,
    ...overrides,
  }
}

const ids = (tapes: Tape[]): string[] => tapes.map((t) => t.id)

describe('selectTapesToStart', () => {
  it('starts the topmost waiting Inbox tapes: newest added first, a batch in its pasted order', () => {
    const tapes = [
      tape('old', 'queued', { addedAtUtc: '2026-01-01T00:00:00.000Z' }),
      tape('batch2', 'queued', { addedAtUtc: '2026-03-01T00:00:00.000Z', addedIndex: 1 }),
      tape('single', 'queued', { addedAtUtc: '2026-02-01T00:00:00.000Z' }),
      tape('batch1', 'queued', { addedAtUtc: '2026-03-01T00:00:00.000Z', addedIndex: 0 }),
    ]
    expect(ids(selectTapesToStart(tapes, new Set(), 3))).toEqual(['batch1', 'batch2', 'single'])
  })

  it('never starts a shelved tape', () => {
    expect(selectTapesToStart([tape('a', 'queued', { shelved: true })], new Set(), 2)).toEqual([])
  })

  it('starts queued tapes up to the free slots, in list order', () => {
    const tapes = [tape('a', 'queued'), tape('b', 'queued'), tape('c', 'queued')]
    expect(ids(selectTapesToStart(tapes, new Set(), 2))).toEqual(['a', 'b'])
  })

  it('counts active jobs against the cap', () => {
    const tapes = [tape('a', 'queued'), tape('b', 'queued')]
    // One slot free (cap 2, one already active).
    expect(ids(selectTapesToStart(tapes, new Set(['x']), 2))).toEqual(['a'])
  })

  it('returns nothing when at or over the cap', () => {
    const tapes = [tape('a', 'queued')]
    expect(selectTapesToStart(tapes, new Set(['x', 'y']), 2)).toEqual([])
    expect(selectTapesToStart(tapes, new Set(['x', 'y', 'z']), 2)).toEqual([])
  })

  it('skips tapes that are not queued or are already active', () => {
    const tapes = [tape('a', 'downloading'), tape('b', 'queued'), tape('c', 'queued'), tape('d', 'paused')]
    expect(ids(selectTapesToStart(tapes, new Set(['c']), 5))).toEqual(['b'])
  })
})
