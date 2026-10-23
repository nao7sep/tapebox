import { nanoid } from 'nanoid'
import { handle } from './handle'
import * as scanService from '@main/services/ytdlp-scan'
import * as session from '@main/store/session'
import { createScanStore, type ScanStore } from '@main/store/scan-store'
import { describeError } from '@shared/error'
import { isImportableUrl } from '@shared/url'
import { log } from '@main/io/logger'
import type { ScanPage } from '@shared/ipc-contract'
import { UserFacingError } from '@main/user-facing-error'
import { message } from '@shared/i18n/translate'
import { runCancellable } from '@main/work-registry'
import { addScannedUrls } from './downloads'

type Scan = { store: ScanStore; handle: scanService.ScanHandle; status: ScanPage['status']; settled: Promise<void>; adding?: Promise<{ added: number }>; releasing?: Promise<void> }
const scans = new Map<string, Scan>()
// Store creation is owned too: Quit may arrive before start returns its id.
const starting = new Set<Promise<unknown>>()
let closed = false
let admission = 0

function find(id: string): Scan {
  const scan = scans.get(id)
  if (!scan || scan.releasing) throw new Error('Scan is no longer available.')
  return scan
}

export function registerScanHandlers(): void {
  handle('scan:start', ({ url }) => {
    if (!isImportableUrl(url)) throw new UserFacingError('invalid', message('errors.scanUrlInvalid'))
    if (closed) throw new Error('TapeBox is quitting.')
    const generation = admission
    const start = (async () => {
      const store = await createScanStore()
      if (closed || generation !== admission) { await store.close(); throw new Error('TapeBox is quitting.') }
      const sessionId = nanoid(8)
      let producer: scanService.ScanHandle
      try {
        producer = scanService.startScan(url, sessionId, raw => store.append({
          sourceId: raw.id, sourceUrl: raw.url, title: raw.title,
          durationSeconds: raw.duration,
          uploadDateUtc: raw.uploadDate ? ymdToUtcIso(raw.uploadDate) : null,
          thumbnailUrl: raw.thumbnailUrl,
          alreadyInLibrary: !!session.sourceOwner({ url: raw.url, extractor: raw.extractor, sourceId: raw.id }),
          unavailable: null,
        }))
      } catch (error) { await store.close(); throw error }
      const scan: Scan = { store, handle: producer, status: 'running', settled: Promise.resolve() }
      scan.settled = producer.complete.then(outcome => {
        scan.status = outcome.kind
        if (outcome.kind === 'failed') log.warn('scan failed', { sessionId, error: describeError(outcome.error) })
      })
      scans.set(sessionId, scan)
      return { sessionId }
    })()
    starting.add(start)
    void start.then(() => starting.delete(start), () => starting.delete(start))
    return start
  })
  handle('scan:cancel', async ({ sessionId }) => {
    const scan = scans.get(sessionId)
    if (!scan) return
    scan.handle.cancel('cancel')
    await scan.settled
  })
  handle('scan:release', async ({ sessionId }) => {
    const scan = scans.get(sessionId)
    if (scan) await release(sessionId, scan)
  })
  handle('scan:page', async ({ sessionId, search, start }) => {
    const scan = find(sessionId)
    return { ...await scan.store.page(search, start), status: scan.status }
  })
  handle('scan:select', async ({ sessionId, ...selection }) => {
    const scan = find(sessionId)
    if (scan.adding) throw new Error('Selected entries are being added.')
    await scan.store.select(selection)
  })
  handle('scan:add', ({ sessionId }) => {
    const scan = find(sessionId)
    if (scan.adding) return scan.adding
    const adding = runCancellable(async signal => {
      scan.handle.cancel('cancel')
      await scan.settled
      signal.throwIfAborted()
      const first = await scan.store.selected(0)
      async function* urls(): AsyncIterable<string> {
        let page = first
        while (page.entries.length) {
          for (const entry of page.entries) yield entry.url
          signal.throwIfAborted()
          page = await scan.store.selected(page.entries.at(-1)!.sequence)
        }
      }
      return { added: await addScannedUrls(urls(), first.count, signal) }
    })
    scan.adding = adding
    void adding.then(() => { scan.adding = undefined }, () => { scan.adding = undefined })
    return adding
  })
}

function release(id: string, scan: Scan): Promise<void> {
  return scan.releasing ??= (async () => {
    scan.handle.cancel('cancel')
    await scan.settled
    await scan.adding?.catch(() => {}) // The add caller owns its result; disposal still joins it.
    try { await scan.store.close() } finally { scans.delete(id) }
  })()
}
export function hasActiveScans(): boolean {
  return starting.size > 0 || [...scans.values()].some(scan => scan.status === 'running')
}
export async function cancelAllScans(): Promise<void> {
  closed = true
  admission++
  const pendingStarts = [...starting]
  const running = [...scans.values()]
  for (const scan of running) scan.handle.cancel('quit')
  await Promise.all([...running.map(scan => scan.settled), ...pendingStarts.map(start => start.catch(() => {}))])
}
/** Final, non-cancellable shutdown: a cancelled quit keeps stopped results. */
export async function closeScanStores(): Promise<void> {
  await Promise.all([...scans].map(([id, scan]) => release(id, scan)))
}
export function resumeScans(): void { closed = false }

function ymdToUtcIso(ymd: string): string | null {
  const m = ymd.match(/^(\d{4})(\d{2})(\d{2})$/)
  return m ? `${m[1]}-${m[2]}-${m[3]}T00:00:00.000Z` : null
}
