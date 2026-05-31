import { binaryPath } from '@main/paths'
import { log } from '@main/io/logger'
import { getSettings } from '@main/store/config'
import {
  makeLineBuffer,
  spawnStreaming,
  waitForExit,
} from '@main/io/spawn'
import { ytdlpEnv } from './ytdlp'
import { resolveYtdlpArgs } from './ytdlp-args'

/**
 * Playlist / channel enumeration via yt-dlp. startEnumeration streams entries
 * from --flat-playlist -j, one JSON per line, calling onEntry as each arrives.
 *
 * Borrows the ytdlpProbe timeout for its idle watchdog. The policy's retries
 * don't apply here — a streaming enumeration can't be retried without re-emitting
 * entries already delivered to onEntry.
 */

export type EnumeratedEntry = {
  id: string
  url: string
  title: string | null
  duration: number | null
  uploadDate: string | null
  thumbnailUrl: string | null
}

export type EnumerationHandle = {
  cancel: () => void
  complete: Promise<{ totalCount: number }>
}

export function startEnumeration(
  url: string,
  onEntry: (entry: EnumeratedEntry) => void,
): EnumerationHandle {
  const ctl = new AbortController()
  const child = spawnStreaming(
    binaryPath('yt-dlp'),
    [...resolveYtdlpArgs(url), '--flat-playlist', '-j', '--no-warnings', url],
    { env: ytdlpEnv(), signal: ctl.signal, idleTimeoutMs: getSettings().network.ytdlpProbe.timeoutMs ?? undefined },
  )

  let total = 0

  const lineBuffer = makeLineBuffer((line) => {
    if (!line) return
    try {
      const info = JSON.parse(line) as Record<string, unknown>
      const entry = parseEntry(info)
      if (entry) {
        onEntry(entry)
        total++
      }
    } catch (err) {
      log.warn('enum: bad json line', { error: String(err) })
    }
  })

  child.stdout.on('data', lineBuffer.feed)

  const complete = (async () => {
    try {
      await waitForExit(child, { reject: false, command: 'yt-dlp enum' })
    } finally {
      lineBuffer.flush()
    }
    return { totalCount: total }
  })()

  return {
    cancel: () => ctl.abort(),
    complete,
  }
}

function parseEntry(info: Record<string, unknown>): EnumeratedEntry | null {
  const id = typeof info['id'] === 'string' ? info['id'] : null
  if (!id) return null
  const url =
    typeof info['url'] === 'string'        ? info['url']
    : typeof info['webpage_url'] === 'string' ? info['webpage_url']
    : null
  if (!url) return null
  return {
    id,
    url,
    title: typeof info['title'] === 'string' ? info['title'] : null,
    duration: typeof info['duration'] === 'number' ? info['duration'] : null,
    uploadDate: typeof info['upload_date'] === 'string' ? info['upload_date'] : null,
    thumbnailUrl: extractThumbnail(info),
  }
}

function extractThumbnail(info: Record<string, unknown>): string | null {
  if (typeof info['thumbnail'] === 'string') return info['thumbnail']
  const thumbnails = info['thumbnails']
  if (Array.isArray(thumbnails) && thumbnails.length > 0) {
    const last = thumbnails[thumbnails.length - 1]
    if (last && typeof last === 'object' && typeof (last as Record<string, unknown>)['url'] === 'string') {
      return (last as Record<string, unknown>)['url'] as string
    }
  }
  return null
}
