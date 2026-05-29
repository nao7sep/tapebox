import { dirname, extname, join } from 'node:path'
import { binaryPath, paths } from '@main/paths'
import { getSettings } from '@main/store/config'
import { withRetry } from '@main/io/retry'
import {
  execCapture,
  IdleTimeoutError,
  makeLineBuffer,
  spawnStreaming,
  waitForExit,
} from '@main/io/spawn'

/**
 * yt-dlp subprocess service.
 *
 * Adds ~/.tapebox/bin to PATH when spawning so yt-dlp can locate the bundled
 * ffmpeg (for merge) and Deno (for the JS runtime YouTube requires since
 * 2025.11.12).
 */

export function ytdlpEnv(): NodeJS.ProcessEnv {
  const sep = process.platform === 'win32' ? ';' : ':'
  return {
    ...process.env,
    PATH: `${paths.bin}${sep}${process.env['PATH'] ?? ''}`,
  }
}

export type ProbeChapter = { start_time: number; end_time: number; title: string }
export type ProbeVideo = {
  kind: 'video'
  id: string
  title: string
  originalTitle: string | null
  uploader: string | null
  duration: number | null
  thumbnail: string | null
  chapters: ProbeChapter[] | null
}
/** A single video to download, or a playlist/channel the caller should reject. */
export type ProbeResult = ProbeVideo | { kind: 'playlist' }

/**
 * Single-video probe. Returns the parsed --dump-json video, or { kind:
 * 'playlist' } when the URL is a playlist/channel rather than one video.
 *
 * Detection: --no-playlist isolates a single video for watch?v=…&list=… URLs,
 * but for a pure playlist/channel URL it has nothing to isolate, so yt-dlp
 * dumps one compact JSON line per entry. >1 line therefore means "not a single
 * video" — we report 'playlist' so the caller can steer the user to the scanner
 * instead of failing on a JSON parse error.
 *
 * Retries only on a stall (IdleTimeoutError): a clean non-zero exit means
 * yt-dlp already ran its own --retries and the URL is genuinely unusable.
 */
export async function probe(url: string, signal: AbortSignal): Promise<ProbeResult> {
  const policy = getSettings().network.lookups
  const { stdout } = await withRetry(
    policy,
    () =>
      execCapture(
        binaryPath('yt-dlp'),
        ['--dump-json', '--skip-download', '--no-warnings', '--no-playlist', url],
        { env: ytdlpEnv(), signal, idleTimeoutMs: policy.timeoutMs },
      ),
    { signal, isRetryable: (e) => e instanceof IdleTimeoutError },
  )
  const lines = stdout.split('\n').map((l) => l.trim()).filter(Boolean)
  if (lines.length > 1) return { kind: 'playlist' }

  const info = JSON.parse(lines[0] ?? '') as Record<string, unknown>
  return {
    kind: 'video',
    id: String(info['id'] ?? ''),
    title: String(info['title'] ?? ''),
    // TODO: yt-dlp can return locale-translated titles. Use --extractor-args
    // for the original title when we figure out the reliable flag.
    originalTitle: typeof info['title'] === 'string' ? info['title'] : null,
    uploader: stringOrNull(info['uploader'] ?? info['channel']),
    duration: typeof info['duration'] === 'number' ? info['duration'] : null,
    thumbnail: stringOrNull(info['thumbnail']),
    chapters: Array.isArray(info['chapters']) ? (info['chapters'] as ProbeChapter[]) : null,
  }
}

function stringOrNull(v: unknown): string | null {
  return typeof v === 'string' ? v : null
}

export type DownloadOptions = {
  url: string
  libraryDir: string
  outputId: string
  onProgress?: (percent: number) => void
  signal: AbortSignal
}

export type DownloadResult = {
  mediaPath: string
  infoJsonPath: string
}

const FINAL_PATH_MARKER = 'tapebox-final-filepath:'

/**
 * Download video+audio, merged, with sidecar info.json.
 * Filename stem is opts.outputId (yt-dlp's video id) so the on-disk name is
 * stable until the user renames to a slug.
 */
export async function download(opts: DownloadOptions): Promise<DownloadResult> {
  const captured: { finalPath: string | null } = { finalPath: null }
  let lastPct = -1

  const child = spawnStreaming(
    binaryPath('yt-dlp'),
    [
      '--paths', `home:${opts.libraryDir}`,
      '--write-info-json',
      '--output', `${opts.outputId}.%(ext)s`,
      '--no-playlist',
      '--no-warnings',
      '--newline',
      '--print', `after_move:${FINAL_PATH_MARKER}%(filepath)s`,
      opts.url,
    ],
    { env: ytdlpEnv(), signal: opts.signal, idleTimeoutMs: getSettings().network.download.timeoutMs },
  )

  const lineBuffer = makeLineBuffer((line) => {
    if (!line) return
    if (line.startsWith(FINAL_PATH_MARKER)) {
      captured.finalPath = line.slice(FINAL_PATH_MARKER.length)
      return
    }
    const m = line.match(/\[download\]\s+(\d+(?:\.\d+)?)%/)
    if (m && m[1]) {
      const pct = parseFloat(m[1])
      if (pct !== lastPct) {
        lastPct = pct
        opts.onProgress?.(pct)
      }
    }
  })

  child.stdout.on('data', lineBuffer.feed)
  child.stderr.on('data', lineBuffer.feed)

  try {
    await waitForExit(child, { command: 'yt-dlp download' })
  } finally {
    lineBuffer.flush()
  }

  const finalPath = captured.finalPath
  if (!finalPath) {
    throw new Error('yt-dlp did not report a final file path')
  }
  const dir = dirname(finalPath)
  const baseName = finalPath.slice(dir.length + 1)
  const stem = baseName.slice(0, -extname(baseName).length)
  return {
    mediaPath: finalPath,
    infoJsonPath: join(dir, `${stem}.info.json`),
  }
}
