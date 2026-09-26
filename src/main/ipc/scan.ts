import { nanoid } from 'nanoid'
import { handle } from './handle'
import { emit } from './events'
import * as scanService from '@main/services/ytdlp-scan'
import * as session from '@main/store/session'
import { describeError } from '@shared/error'
import { isImportableUrl } from '@shared/url'
import { librarySourceIndex } from '@shared/source-identity'
import { log } from '@main/io/logger'
import type { ScanResult } from '@shared/ipc-contract'
import { UserFacingError } from '@main/user-facing-error'

/**
 * Scan session lifecycle. The Scan-a-page modal subscribes to the events
 * below, then calls scan:start (which returns the sessionId used to filter
 * events and cancel the stream).
 *
 * Events:
 *   scan:entry  — per video as it arrives
 *   scan:done   — stream finished, possibly with partial results after a yt-dlp error
 *   scan:error  — yt-dlp failed before listing anything
 * A stopped scan emits neither.
 */

const active = new Map<string, scanService.ScanHandle>()
let closed = false

export function registerScanHandlers(): void {
  handle('scan:start', async ({ url }) => {
    // Same trust-boundary gate as downloads: only http(s) reaches yt-dlp.
    if (!isImportableUrl(url)) {
      throw new UserFacingError('invalid', 'Enter a valid http(s) URL to scan.')
    }
    if (closed) throw new Error('TapeBox is quitting.')
    const sessionId = nanoid(8)
    // Mark what the library already holds with its one identity rule: the
    // (extractor, id) pair for probed tapes, the canonical URL for any tape,
    // including ones still queued unprobed (added with autostart off).
    const known = librarySourceIndex(session.getTapes())

    const handle_ = scanService.startScan(url, (raw) => {
      const entry: ScanResult = {
        sourceId: raw.id,
        sourceUrl: raw.url,
        title: raw.title,
        durationSeconds: raw.duration,
        uploadDateUtc: raw.uploadDate ? ymdToUtcIso(raw.uploadDate) : null,
        thumbnailUrl: raw.thumbnailUrl,
        alreadyInLibrary: known.has({ url: raw.url, extractor: raw.extractor, sourceId: raw.id }),
        unavailable: null,
      }
      emit('scan:entry', { sessionId, entry })
    })

    active.set(sessionId, handle_)
    void handle_.complete
      .then((outcome) => {
        if (outcome.kind === 'done') emit('scan:done', { sessionId, totalCount: outcome.totalCount })
        else if (outcome.kind === 'failed') {
          log.warn('scan failed', { sessionId, error: describeError(outcome.error) })
          emit('scan:error', { sessionId, code: 'scan-failed' })
        }
        // A stopped scan emits nothing: whoever stopped it already settled the dialog.
      })
      .finally(() => active.delete(sessionId))

    return { sessionId }
  })

  handle('scan:cancel', async ({ sessionId }) => {
    active.get(sessionId)?.cancel()
    active.delete(sessionId)
  })
}

/** Quit-time teardown: stop every running scan and wait for its yt-dlp tree to exit. */
export async function cancelAllScans(): Promise<void> {
  closed = true
  const handles = [...active.values()]
  active.clear()
  for (const scan of handles) scan.cancel()
  await Promise.allSettled(handles.map((scan) => scan.complete))
}

function ymdToUtcIso(ymd: string): string | null {
  const m = ymd.match(/^(\d{4})(\d{2})(\d{2})$/)
  if (!m) return null
  return `${m[1]}-${m[2]}-${m[3]}T00:00:00.000Z`
}
