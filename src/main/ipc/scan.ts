import { nanoid } from 'nanoid'
import { handle } from './handle'
import { emit } from './events'
import * as scanService from '@main/services/ytdlp-scan'
import * as session from '@main/store/session'
import { describeError, errorMessage } from '@main/io/spawn'
import { log } from '@main/io/logger'
import type { ScanResult } from '@shared/ipc-contract'

/**
 * Scan session lifecycle. The Scan-a-page modal subscribes to the events
 * below, then calls scan:start (which returns the sessionId used to filter
 * events and cancel the stream).
 *
 * Events:
 *   scan:entry  — per video as it arrives
 *   scan:done   — stream finished naturally
 *   scan:error  — stream errored
 */

const active = new Map<string, scanService.ScanHandle>()

export function registerScanHandlers(): void {
  handle('scan:start', async ({ url }) => {
    const sessionId = nanoid(8)
    // Dedupe against the library by video id AND url. id is the reliable key but
    // is only set once an tape has been probed; url is the fallback that catches
    // tapes still queued unprobed (added with autostart off).
    const tapes = session.getTapes()
    const knownSourceIds = new Set(tapes.map((i) => i.sourceId).filter((x): x is string => !!x))
    const knownSourceUrls = new Set(tapes.map((i) => i.sourceUrl))

    const handle_ = scanService.startScan(url, (raw) => {
      const entry: ScanResult = {
        sourceId: raw.id,
        sourceUrl: raw.url,
        title: raw.title,
        durationSeconds: raw.duration,
        uploadDateUtc: raw.uploadDate ? ymdToUtcIso(raw.uploadDate) : null,
        thumbnailUrl: raw.thumbnailUrl,
        alreadyInLibrary: knownSourceIds.has(raw.id) || knownSourceUrls.has(raw.url),
        unavailable: null,
      }
      emit('scan:entry', { sessionId, entry })
    })

    active.set(sessionId, handle_)
    void handle_.complete
      .then(({ totalCount }) => emit('scan:done', { sessionId, totalCount }))
      .catch((err) => {
        log.warn('scan stream errored', { sessionId, ...describeError(err) })
        emit('scan:error', { sessionId, error: errorMessage(err) })
      })
      .finally(() => active.delete(sessionId))

    return { sessionId }
  })

  handle('scan:cancel', async ({ sessionId }) => {
    active.get(sessionId)?.cancel()
    active.delete(sessionId)
  })
}

function ymdToUtcIso(ymd: string): string | null {
  const m = ymd.match(/^(\d{4})(\d{2})(\d{2})$/)
  if (!m) return null
  return `${m[1]}-${m[2]}-${m[3]}T00:00:00.000Z`
}
