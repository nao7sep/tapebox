import { nanoid } from 'nanoid'
import { handle } from './handle'
import { emit } from './events'
import * as enumService from '@main/services/ytdlp-enum'
import * as session from '@main/store/session'
import { log } from '@main/io/logger'
import type { EnumEntry } from '@shared/ipc-contract'

/**
 * Enumeration session lifecycle, split into two IPC calls so the renderer can
 * attach event subscribers before any streaming begins:
 *   - enum:detect — one-shot probe. Returns kind (single/multi) + source title.
 *   - enum:start  — once the modal is mounted and subscribed, start streaming.
 *                   Returns the sessionId used to filter events and cancel.
 *
 * Events:
 *   enum:entry  — per video as it arrives
 *   enum:done   — stream finished naturally
 *   enum:error  — stream errored
 */

const active = new Map<string, enumService.EnumerationHandle>()
const detectAbortDeadlineMs = 20_000

export function registerEnumHandlers(): void {
  handle('enum:detect', async ({ url }) => {
    const ctl = new AbortController()
    const t = setTimeout(() => ctl.abort(), detectAbortDeadlineMs)
    try {
      const detected = await enumService.detectKind(url, ctl.signal)
      return { kind: detected.kind, sourceTitle: detected.title }
    } finally {
      clearTimeout(t)
    }
  })

  handle('enum:start', async ({ url }) => {
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
