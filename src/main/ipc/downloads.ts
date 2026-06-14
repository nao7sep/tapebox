import { handle } from './handle'
import { emit } from './events'
import * as session from '@main/store/session'
import { getSettings } from '@main/store/config'
import { reserveStem } from '@main/core/stem'
import * as queue from '@main/queue/manager'
import { nowUtcIso } from '@shared/utc'
import { frontOrders } from '@shared/order'
import { canonicalizeForDedup, isImportableUrl } from '@shared/url'
import type { Tape } from '@shared/domain'

/** Orders that drop a block of `count` new tapes onto the top of the inbox. */
function inboxFrontOrders(count: number): number[] {
  const inbox = session.getTapes().filter((i) => !i.archivedAtUtc)
  return frontOrders(inbox.map((i) => i.order), count)
}

export function registerDownloadHandlers(): void {
  handle('downloads:add', async ({ url }) => {
    const trimmed = url.trim()
    // Gate the scheme at the trust boundary: only http(s) reaches yt-dlp, never
    // file:// or an internal scheme a renderer could otherwise drive it at.
    if (!isImportableUrl(trimmed)) {
      throw new Error('Enter a valid http(s) URL.')
    }
    // URL-based dedup for the single-add path (no id yet — it's unprobed). Compare
    // canonical forms so the same video pasted with tracking junk / a fragment isn't
    // added twice and re-probed. Any existing tape blocks the add, in any state; a
    // failed one is resumed via Retry, not re-added.
    const canonical = canonicalizeForDedup(trimmed)
    if (session.getTapes().some((i) => canonicalizeForDedup(i.sourceUrl) === canonical)) {
      throw new Error('This URL has already been added.')
    }
    const [order] = inboxFrontOrders(1)
    const tape = await makeQueuedTape(trimmed, order)
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
    const seen = new Set(session.getTapes().map((i) => canonicalizeForDedup(i.sourceUrl)))
    const accepted: string[] = []
    for (const url of urls) {
      const trimmed = url.trim()
      // Skip blanks and any non-http(s) scheme (the trust-boundary gate); dedup by
      // canonical form so tracking-param variants of the same link collapse.
      if (!trimmed || !isImportableUrl(trimmed)) continue
      const canonical = canonicalizeForDedup(trimmed)
      if (seen.has(canonical)) continue
      seen.add(canonical)
      accepted.push(trimmed)
    }
    if (accepted.length === 0) return []
    // One front-of-inbox window for the whole batch, so the paste lands as a block
    // on top in its original order (first URL topmost). Stems are reserved
    // sequentially to avoid two tapes racing for the same on-disk name.
    const orders = inboxFrontOrders(accepted.length)
    const tapes: Tape[] = []
    for (let i = 0; i < accepted.length; i++) {
      tapes.push(await makeQueuedTape(accepted[i], orders[i]))
    }
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

async function makeQueuedTape(url: string, order: number): Promise<Tape> {
  const autostart = getSettings().autoStartDownloads
  const now = nowUtcIso()
  // The id doubles as the on-disk filename stem once the download lands, so it is
  // reserved against the library to guarantee a free {id}.* namespace.
  const id = await reserveStem(getSettings().libraryDir)
  return {
    id,
    sourceUrl: url,
    state: autostart ? 'queued' : 'paused',
    addedAtUtc: now,
    sourceId: null,
    extractor: null,
    title: null,
    uploader: null,
    durationSeconds: null,
    chapterCount: null,
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
    order,
    pausedAtUtc: autostart ? null : now,
    failedAtUtc: null,
    lastError: null,
  }
}
