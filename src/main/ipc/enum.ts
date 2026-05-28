import { nanoid } from 'nanoid'
import { handle } from './handle'
import { emit } from './events'
import * as enumService from '@main/services/ytdlp-enum'
import * as session from '@main/store/session'
import { log } from '@main/io/logger'
import type { EnumEntry } from '@shared/ipc-contract'

/**
 * Enumeration session lifecycle:
 *   enum:start  -> probe kind. If single, return immediately. If multi, start
 *                  background streaming and return a sessionId.
 *   enum:entry  -> emitted per video as it arrives from yt-dlp.
 *   enum:done   -> stream finished naturally.
 *   enum:error  -> stream errored.
 *   enum:cancel -> abort the stream.
 */

const active = new Map<string, enumService.EnumerationHandle>()

export function registerEnumHandlers(): void {
  handle('enum:start', async ({ url }) => {
    const detectCtl = new AbortController()
    const kindTimeout = setTimeout(() => detectCtl.abort(), 20_000)
    let detected: { kind: 'single' | 'multi'; title: string | null }
    try {
      detected = await enumService.detectKind(url, detectCtl.signal)
    } finally {
      clearTimeout(kindTimeout)
    }

    if (detected.kind === 'single') {
      return {
        sessionId: nanoid(8),
        kind: 'single' as const,
        sourceTitle: detected.title,
      }
    }

    const sessionId = nanoid(8)
    const knownSourceIds = new Set(
      session.getItems()
        .map((i) => i.sourceId)
        .filter((x): x is string => !!x),
    )

    const handle_ = enumService.startEnumeration(url, (raw) => {
      const entry: EnumEntry = {
        sourceId: raw.id,
        sourceUrl: raw.url,
        title: raw.title,
        durationSeconds: raw.duration,
        uploadDateUtc: raw.uploadDate ? ymdToUtcIso(raw.uploadDate) : null,
        thumbnailUrl: raw.thumbnailUrl,
        alreadyInLibrary: knownSourceIds.has(raw.id),
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

    return {
      sessionId,
      kind: 'multi' as const,
      sourceTitle: detected.title,
    }
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
