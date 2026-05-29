import { binaryPath } from '@main/paths'
import { log } from '@main/io/logger'
import { getSettings } from '@main/store/config'
import { withRetry } from '@main/io/retry'
import {
  execCapture,
  IdleTimeoutError,
  makeLineBuffer,
  spawnStreaming,
  waitForExit,
} from '@main/io/spawn'
import { ytdlpEnv } from './ytdlp'

/**
 * Playlist / channel enumeration via yt-dlp.
 *
 * Two operations:
 *   - detectKind: one-shot, runs --dump-single-json to learn if URL points to
 *     a single video or a multi-entry container.
 *   - startEnumeration: streams entries from --flat-playlist -j, one JSON
 *     per line, calling onEntry as each arrives.
 */

export type EnumeratedEntry = {
  id: string
  url: string
  title: string | null
  duration: number | null
  uploadDate: string | null
  thumbnailUrl: string | null
}

export async function detectKind(
  url: string,
  signal: AbortSignal,
): Promise<{ kind: 'single' | 'multi'; title: string | null }> {
  const policy = getSettings().network.lookups
  const { stdout } = await withRetry(
    policy,
    () =>
      execCapture(
        binaryPath('yt-dlp'),
        ['--flat-playlist', '--dump-single-json', '--no-warnings', url],
        { env: ytdlpEnv(), signal, idleTimeoutMs: policy.timeoutMs },
      ),
    { signal, isRetryable: (e) => e instanceof IdleTimeoutError },
  )
  const info = JSON.parse(stdout) as Record<string, unknown>
  const isMulti = info['_type'] === 'playlist' || Array.isArray(info['entries'])
  const title = typeof info['title'] === 'string' ? info['title'] : null
  return { kind: isMulti ? 'multi' : 'single', title }
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
    ['--flat-playlist', '-j', '--no-warnings', url],
    { env: ytdlpEnv(), signal: ctl.signal, idleTimeoutMs: getSettings().network.lookups.timeoutMs },
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
    : `https://www.youtube.com/watch?v=${id}`
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
