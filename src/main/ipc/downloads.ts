import { handle } from './handle'
import { emit } from './events'
import * as session from '@main/store/session'
import { getLibraryDir, getSettings } from '@main/store/config'
import { reserveStem } from '@main/core/stem'
import * as queue from '@main/queue/manager'
import { nowUtcIso } from '@shared/utc'
import { frontOrders } from '@shared/order'
import { canonicalizeForDedup, isImportableUrl } from '@shared/url'
import type { Tape } from '@shared/domain'
import { UserFacingError } from '@main/user-facing-error'

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
      throw new UserFacingError('invalid', 'Enter a valid http(s) URL.')
    }
    // Reserve the on-disk stem first: it is the only await. The dedup check, the
    // order and the insert then happen in one synchronous turn, so two quick Adds
    // of the same URL cannot both pass the check.
    const id = await reserveStem(getLibraryDir())
    // URL-based dedup for the single-add path (no id yet — it's unprobed). Compare
    // canonical forms so the same video pasted with tracking junk / a fragment isn't
    // added twice and re-probed. Any existing tape blocks the add, in any state; a
    // failed one is resumed via Retry, not re-added.
    const canonical = canonicalizeForDedup(trimmed)
    if (session.getTapes().some((i) => canonicalizeForDedup(i.sourceUrl) === canonical)) {
      throw new UserFacingError('refused', 'This URL is already in the library.')
    }
    const [order] = inboxFrontOrders(1)
    const tape = queuedTape(id, trimmed, order)
    session.upsertTape(tape)
    emit('tapes:added', [tape])
    queue.tick()
    return [tape]
  })

  handle('downloads:addBulk', async ({ urls }) => {
    // Skip blanks and any non-http(s) scheme (the trust-boundary gate).
    const candidates = newUrls([], urls.map((url) => url.trim()).filter((url) => url && isImportableUrl(url)))
    if (candidates.length === 0) return []
    // Reserve stems first (the only awaits), then dedup and insert in one
    // synchronous turn so a concurrent add cannot slip a duplicate in between.
    const ids: string[] = []
    for (let i = 0; i < candidates.length; i++) ids.push(await reserveStem(getLibraryDir()))
    const accepted = newUrls(session.getTapes(), candidates)
    if (accepted.length === 0) return []
    // One front-of-inbox window for the whole batch, so the paste lands as a block
    // on top in its original order (first URL topmost).
    const orders = inboxFrontOrders(accepted.length)
    const tapes = accepted.map((url, i) => queuedTape(ids[i]!, url, orders[i]!))
    for (const tape of tapes) session.upsertTape(tape)
    emit('tapes:added', tapes)
    queue.tick()
    return tapes
  })

  handle('downloads:cancel', async ({ tapeId }) => {
    await queue.cancel(tapeId)
  })

  handle('downloads:retry', async ({ tapeId }) => {
    const tape = session.getTape(tapeId)
    const patch = tape ? retryPatch(tape) : null
    if (!patch) return
    transition(tapeId, patch)
    queue.tick()
  })
}

/**
 * What Retry (and Resume) does to a tape. A failed or paused download re-queues;
 * its next attempt clears the stem's leftovers before downloading again. A failed
 * row that already names its finished files was failed by a catalog write after the
 * download completed (earlier versions did this), so it is restored as downloaded:
 * re-queuing it would delete those files. Any other state is left as it is, so a
 * stray Retry can never send a finished tape back through a download.
 */
export function retryPatch(tape: Tape): Partial<Tape> | null {
  if (tape.state !== 'failed' && tape.state !== 'paused') return null
  if (tape.state === 'failed' && tape.filename && tape.sidecarFilename) {
    return { state: 'downloaded', failureCode: null, lastError: null, failedAtUtc: null }
  }
  return { state: 'queued', failureCode: null, lastError: null }
}

function transition(tapeId: string, patch: Partial<Tape>): void {
  const tape = session.getTape(tapeId)
  if (!tape) return
  const next = { ...tape, ...patch }
  session.upsertTape(next)
  emit('tapes:updated', next)
}

/**
 * Dedup by URL against the library and within the batch itself, so adding the
 * same scan twice (or a list with repeats) can't create duplicate rows. The set
 * grows as it goes, which collapses intra-batch repeats too. Same-video-
 * different-URL collisions are caught later, post-probe, in the queue.
 */
export function newUrls(tapes: readonly Tape[], urls: readonly string[]): string[] {
  const seen = new Set(tapes.map((i) => canonicalizeForDedup(i.sourceUrl)))
  const accepted: string[] = []
  for (const url of urls) {
    const canonical = canonicalizeForDedup(url)
    if (seen.has(canonical)) continue
    seen.add(canonical)
    accepted.push(url)
  }
  return accepted
}

/** A new tape for `url`. Its id doubles as the on-disk filename stem once the
 * download lands, so the caller reserves it against the library first. */
function queuedTape(id: string, url: string, order: number): Tape {
  const autostart = getSettings().autoStartDownloads
  const now = nowUtcIso()
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
    failureCode: null,
    lastError: null,
  }
}
