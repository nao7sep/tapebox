import { describe, it, expect } from 'vitest'

import { selectTapesToStart, planOrphanResets } from '@main/queue/schedule'
import type { Tape } from '@shared/domain'

const NOW = '2026-06-26T00:00:00.000Z'

function tape(id: string, state: Tape['state']): Tape {
  return {
    id,
    sourceUrl: `http://example.com/${id}`,
    state,
    addedAtUtc: '2026-01-01T00:00:00.000Z',
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
    archivedAtUtc: null,
    boxId: null,
    order: 0,
    pausedAtUtc: null,
    failedAtUtc: null,
    lastError: null,
  }
}

const ids = (tapes: Tape[]): string[] => tapes.map((t) => t.id)

describe('selectTapesToStart', () => {
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

describe('planOrphanResets', () => {
  it('requeues interrupted tapes when autostart is on', () => {
    const tapes = [tape('a', 'probing'), tape('b', 'downloading'), tape('c', 'downloaded')]
    const reset = planOrphanResets(tapes, true, NOW)
    expect(reset.map((t) => [t.id, t.state])).toEqual([
      ['a', 'queued'],
      ['b', 'queued'],
    ])
    expect(reset.every((t) => t.pausedAtUtc === null)).toBe(true)
  })

  it('pauses interrupted tapes (stamping the time) when autostart is off', () => {
    const reset = planOrphanResets([tape('a', 'probing'), tape('b', 'downloading')], false, NOW)
    expect(reset.map((t) => t.state)).toEqual(['paused', 'paused'])
    expect(reset.every((t) => t.pausedAtUtc === NOW)).toBe(true)
  })

  it('leaves tapes in other states untouched (filtered out)', () => {
    const tapes = [tape('a', 'queued'), tape('b', 'ready'), tape('c', 'failed'), tape('d', 'downloaded')]
    expect(planOrphanResets(tapes, true, NOW)).toEqual([])
  })
})
