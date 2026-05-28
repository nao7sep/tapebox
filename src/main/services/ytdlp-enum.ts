import { execa } from 'execa'
import { binaryPath } from '@main/paths'
import { log } from '@main/io/logger'
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
  uploadDate: string | null // raw 'YYYYMMDD' from yt-dlp
  thumbnailUrl: string | null
}

export async function detectKind(
  url: string,
  signal: AbortSignal,
): Promise<{ kind: 'single' | 'multi'; title: string | null }> {
  const { stdout } = await execa(
    binaryPath('yt-dlp'),
    ['--flat-playlist', '--dump-single-json', '--no-warnings', url],
    { env: ytdlpEnv(), cancelSignal: signal },
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
  const child = execa(
    binaryPath('yt-dlp'),
    ['--flat-playlist', '-j', '--no-warnings', url],
    { env: ytdlpEnv(), cancelSignal: ctl.signal, buffer: false, reject: false },
  )

  let total = 0
  let buffer = ''

  const handleChunk = (data: Buffer) => {
    buffer += data.toString('utf8')
    let nl = buffer.indexOf('\n')
    while (nl >= 0) {
      const line = buffer.slice(0, nl).trim()
      buffer = buffer.slice(nl + 1)
      if (line) {
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
      }
      nl = buffer.indexOf('\n')
    }
  }

  child.stdout?.on('data', handleChunk)

  const complete = (async () => {
    await child
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
