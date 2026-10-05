import { describe, expect, it } from 'vitest'

import { moveTape } from '@main/core/tape-state'
import type { Tape } from '@shared/domain'

const EARLIER = '2026-01-01T00:00:00.000Z'
const NOW = '2026-02-02T00:00:00.000Z'

function tape(over: Partial<Tape>): Tape {
  return {
    id: 'Tapestate1', sourceUrl: 'https://example.test/watch', state: 'queued',
    addedAtUtc: EARLIER, sourceId: null, extractor: null, title: null, uploader: null,
    durationSeconds: null, chapterCount: 0, probedAtUtc: null, filename: null,
    sidecarFilename: null, thumbnailFilename: null, downloadStartedAtUtc: null,
    downloadedAtUtc: null, name: null, renamedAtUtc: null, archivedAtUtc: null,
    boxId: null, order: 0, pausedAtUtc: null, failedAtUtc: null, lastError: null,
    ...over,
  }
}

describe('moveTape', () => {
  it('stamps the pause time on entering paused', () => {
    expect(moveTape(tape({ state: 'downloading' }), { state: 'paused' }, NOW).pausedAtUtc).toBe(NOW)
  })

  it('stamps the failure time on entering failed', () => {
    expect(moveTape(tape({ state: 'probing' }), { state: 'failed' }, NOW).failedAtUtc).toBe(NOW)
  })

  it('clears the pause time when a paused tape is resumed', () => {
    const moved = moveTape(tape({ state: 'paused', pausedAtUtc: EARLIER }), { state: 'queued' }, NOW)
    expect(moved).toMatchObject({ state: 'queued', pausedAtUtc: null, failedAtUtc: null })
  })

  it('clears the failure time when a failed tape is retried or restored', () => {
    const failed = tape({ state: 'failed', failedAtUtc: EARLIER, failureCode: 'download', lastError: 'x' })
    expect(moveTape(failed, { state: 'queued', failureCode: null, lastError: null }, NOW).failedAtUtc).toBeNull()
    expect(moveTape(failed, { state: 'downloaded', failureCode: null, lastError: null }, NOW).failedAtUtc).toBeNull()
  })

  it('keeps the time of a state the tape stays in', () => {
    const paused = tape({ state: 'paused', pausedAtUtc: EARLIER })
    expect(moveTape(paused, { state: 'paused' }, NOW).pausedAtUtc).toBe(EARLIER)
  })

  it('applies the rest of the move as given', () => {
    const moved = moveTape(tape({ state: 'probing' }), { state: 'ready', title: 'T', probedAtUtc: NOW }, NOW)
    expect(moved).toMatchObject({ state: 'ready', title: 'T', probedAtUtc: NOW })
  })
})
