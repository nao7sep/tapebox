import { nanoid } from 'nanoid'
import { handle } from './handle'
import { emit } from './events'
import * as enumService from '@main/services/ytdlp-enum'
import * as session from '@main/store/session'
import { log } from '@main/io/logger'
import type { EnumEntry } from '@shared/ipc-contract'

/**
 * Enumeration session lifecycle. The playlist modal subscribes to the events
 * below, then calls enum:start (which returns the sessionId used to filter
 * events and cancel the stream).
 *
 * Events:
 *   enum:entry  — per video as it arrives
 *   enum:done   — stream finished naturally
 *   enum:error  — stream errored
 */

const active = new Map<string, enumService.EnumerationHandle>()

export function registerEnumHandlers(): void {
  handle('enum:start', async ({ url }) => {
    const sessionId = nanoid(8)
    // Dedupe against the library by video id AND url. id is the reliable key but
    // is only set once an item has been probed; url is the fallback that catches
    // items still queued unprobed (added with autostart off).
    const items = session.getItems()
    const knownSourceIds = new Set(items.map((i) => i.sourceId).filter((x): x is string => !!x))
    const knownSourceUrls = new Set(items.map((i) => i.sourceUrl))

    const handle_ = enumService.startEnumeration(url, (raw) => {
      const entry: EnumEntry = {
        sourceId: raw.id,
        sourceUrl: raw.url,
        title: raw.title,
        durationSeconds: raw.duration,
        uploadDateUtc: raw.uploadDate ? ymdToUtcIso(raw.uploadDate) : null,
        thumbnailUrl: raw.thumbnailUrl,
        alreadyInLibrary: knownSourceIds.has(raw.id) || knownSourceUrls.has(raw.url),
        unavailable: null,
      }
      emit('enum:entry', { sessionId, entry })
    })

    active.set(sessionId, handle_)
    void handle_.complete
      .then(({ totalCount }) => emit('enum:done', { sessionId, totalCount }))
      .catch((err) => {
        log.warn('enum stream errored', { sessionId, error: String(err) })
        emit('enum:error', { sessionId, error: String(err) })
      })
      .finally(() => active.delete(sessionId))

    return { sessionId }
  })

  handle('enum:cancel', async ({ sessionId }) => {
    active.get(sessionId)?.cancel()
    active.delete(sessionId)
  })
}

function ymdToUtcIso(ymd: string): string | null {
  const m = ymd.match(/^(\d{4})(\d{2})(\d{2})$/)
  if (!m) return null
  return `${m[1]}-${m[2]}-${m[3]}T00:00:00.000Z`
}
