import { binaryPath } from '@main/paths'
import { log } from '@main/io/logger'
import { YTDLP_PROBE_IDLE_TIMEOUT_MS } from '@main/io/network'
import {
  makeLineBuffer,
  spawnStreaming,
  waitForExit,
} from '@main/io/spawn'
import { errorMessage } from '@shared/error'
import { ytdlpEnv } from './ytdlp'
import { resolveYtdlpArgs } from './ytdlp-args'

/**
 * Page scan via yt-dlp. startScan streams entries
 * from --flat-playlist -j, one JSON per line, calling onEntry as each arrives.
 *
 * Uses the same idle watchdog as the probe; never retried — a streaming
 * scan can't be retried without re-emitting entries already delivered
 * to onEntry.
 */

export type ScannedEntry = {
  id: string
  url: string
  title: string | null
  duration: number | null
  uploadDate: string | null
  thumbnailUrl: string | null
}

export type ScanHandle = {
  cancel: () => void
  complete: Promise<{ totalCount: number }>
}

export function startScan(
  url: string,
  onEntry: (entry: ScannedEntry) => void,
): ScanHandle {
  const ctl = new AbortController()
  const child = spawnStreaming(
    binaryPath('yt-dlp'),
    [...resolveYtdlpArgs(url), '--flat-playlist', '-j', '--no-warnings', url],
    { env: ytdlpEnv(), signal: ctl.signal, idleTimeoutMs: YTDLP_PROBE_IDLE_TIMEOUT_MS },
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
      // A non-JSON line in yt-dlp's streamed output is an expected branch (it
      // interleaves status lines), not an incident — a systemic failure still
      // surfaces as an empty scan result. Developer-only detail; keep it cheap on
      // this per-line path by logging the message only (no stack materialization).
      log.debug('scan: bad json line', { reason: errorMessage(err) })
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

function parseEntry(info: Record<string, unknown>): ScannedEntry | null {
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
