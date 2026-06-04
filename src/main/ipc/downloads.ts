import { nanoid } from 'nanoid'
import { handle } from './handle'
import { emit } from './events'
import * as session from '@main/store/session'
import { getSettings } from '@main/store/config'
import * as queue from '@main/queue/manager'
import { nowUtcIso } from '@shared/utc'
import type { Tape } from '@shared/domain'

export function registerDownloadHandlers(): void {
  handle('downloads:add', async ({ url }) => {
    const trimmed = url.trim()
    // URL-based dedup for the single-add path (no id yet — it's unprobed). Any
    // existing tape with this URL blocks the add, in any state; a failed one is
    // resumed via Retry, not re-added.
    if (session.getTapes().some((i) => i.sourceUrl === trimmed)) {
      throw new Error('This URL has already been added.')
    }
    const tape = makeQueuedTape(trimmed)
    session.upsertTape(tape)
    emit('tapes:added', [tape])
    queue.tick()
    return [tape]
  })

  handle('downloads:addBulk', async ({ urls }) => {
    // Dedup by URL against the library and within the batch itself, so adding the
    // same scan twice (or a list with repeats) can't create duplicate rows. The
    // set grows as we go, which collapses intra-batch repeats too. Same-video-
    // different-URL collisions are caught later, post-probe, in the queue.
    const seen = new Set(session.getTapes().map((i) => i.sourceUrl))
    const tapes: Tape[] = []
    for (const url of urls) {
      const trimmed = url.trim()
      if (!trimmed || seen.has(trimmed)) continue
      seen.add(trimmed)
      tapes.push(makeQueuedTape(trimmed))
    }
    if (tapes.length === 0) return []
    for (const tape of tapes) session.upsertTape(tape)
    emit('tapes:added', tapes)
    queue.tick()
    return tapes
  })

  handle('downloads:cancel', async ({ tapeId }) => {
    await queue.cancel(tapeId)
  })

  handle('downloads:retry', async ({ tapeId }) => {
    // The download clears any stale .part at the start of every attempt, so
    // retry and resume both just re-queue.
    transition(tapeId, { state: 'queued', lastError: null })
    queue.tick()
  })
}

function transition(tapeId: string, patch: Partial<Tape>): void {
  const tape = session.getTape(tapeId)
  if (!tape) return
  const next = { ...tape, ...patch }
  session.upsertTape(next)
  emit('tapes:updated', next)
}

function makeQueuedTape(url: string): Tape {
  const autostart = getSettings().autoStartDownloads
  const now = nowUtcIso()
  return {
    id: nanoid(10),
    sourceUrl: url,
    state: autostart ? 'queued' : 'paused',
    addedAtUtc: now,
    sourceId: null,
    title: null,
    uploader: null,
    durationSeconds: null,
    chapterCount: null,
    thumbnailUrl: null,
    probedAtUtc: null,
    filename: null,
    sidecarFilename: null,
    downloadStartedAtUtc: null,
    downloadedAtUtc: null,
    slug: null,
    renamedAtUtc: null,
    archivedAtUtc: null,
    boxId: null,
    boxOrder: 0,
    pausedAtUtc: autostart ? null : now,
    failedAtUtc: null,
    lastError: null,
  }
}
