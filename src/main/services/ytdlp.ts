import { dirname, extname, join } from 'node:path'
import { readdir, unlink } from 'node:fs/promises'
import { binaryPath, paths } from '@main/paths'
import { resolveYtdlpArgs } from './ytdlp-args'
import { YTDLP_PROBE_IDLE_TIMEOUT_MS } from '@main/io/network'
import {
  execCapture,
  makeLineBuffer,
  spawnStreaming,
  waitForExit,
} from '@main/io/spawn'

/**
 * yt-dlp subprocess service.
 *
 * Adds ~/.tapebox/bin to PATH when spawning so yt-dlp can locate the bundled
 * ffmpeg and Deno.
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
 * Single-video probe. Returns the parsed video info, or { kind: 'playlist' }
 * when the URL is a playlist/channel rather than one video.
 *
 * The flags do double duty: --dump-single-json yields one JSON object whose
 * _type is 'playlist' for a playlist/channel and 'video' for a video, so the
 * kind is a field read, not a parse heuristic. --flat-playlist + --playlist-items 1
 * keep detection O(1): yt-dlp reports the kind without extracting the whole
 * channel (extracting every entry is what used to wedge the queue forever).
 * --no-playlist still isolates the video for watch?v=…&list=… URLs, and single
 * videos keep full metadata, chapters included (verified against a full probe).
 *
 * Never auto-retried: re-hammering a media site risks an IP block, and a probe
 * failure is the user's call (read the log, retry manually). The idle watchdog
 * still kills a silent stall so the queue never hangs.
 */
export async function probe(url: string, signal: AbortSignal): Promise<ProbeResult> {
  const { stdout } = await execCapture(
    binaryPath('yt-dlp'),
    [...resolveYtdlpArgs(url), '--dump-single-json', '--flat-playlist', '--no-playlist', '--playlist-items', '1', '--no-warnings', url],
    { env: ytdlpEnv(), signal, idleTimeoutMs: YTDLP_PROBE_IDLE_TIMEOUT_MS },
  )
  const info = JSON.parse(stdout) as Record<string, unknown>
  if (info['_type'] === 'playlist') return { kind: 'playlist' }

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

/** How many recent yt-dlp output lines to keep so a failure can show what it said. */
const MAX_LOG_LINES = 60

/**
 * Download video+audio, merged, with sidecar info.json.
 * Filename stem is opts.outputId (yt-dlp's video id) so the on-disk name is
 * stable until the user renames to a slug.
 */
export async function download(opts: DownloadOptions): Promise<DownloadResult> {
  // Start from a clean slate: a leftover .part from a prior failed/cancelled run
  // can be stale or oversized and makes yt-dlp's resume fail with HTTP 416.
  // Completed per-format streams are kept and reused.
  await clearPartials(opts.libraryDir, opts.outputId)
  // Never auto-retried: re-running hammers the site and risks a block. yt-dlp
  // runs its own internal --retries for transient blips within the attempt. No
  // idle watchdog: yt-dlp goes silent during the post-download ffmpeg merge of a
  // large file, so a watchdog would kill a healthy job mid-merge.
  return runDownloadOnce(opts, undefined)
}

async function runDownloadOnce(opts: DownloadOptions, idleTimeoutMs: number | undefined): Promise<DownloadResult> {
  const captured: { finalPath: string | null } = { finalPath: null }
  let lastPct = -1

  const child = spawnStreaming(
    binaryPath('yt-dlp'),
    [
      ...resolveYtdlpArgs(opts.url),
      '--paths', `home:${opts.libraryDir}`,
      '--write-info-json',
      '--output', `${opts.outputId}.%(ext)s`,
      '--no-playlist',
      '--no-warnings',
      '--newline',
      '--print', `after_move:${FINAL_PATH_MARKER}%(filepath)s`,
      opts.url,
    ],
    { env: ytdlpEnv(), signal: opts.signal, idleTimeoutMs },
  )

  const recentLines: string[] = []
  const lineBuffer = makeLineBuffer((line) => {
    if (!line) return
    if (line.startsWith(FINAL_PATH_MARKER)) {
      captured.finalPath = line.slice(FINAL_PATH_MARKER.length)
      return
    }
    const m = line.match(/\[download\]\s+(\d+(?:\.\d+)?)%/)
    if (m && m[1]) {
      // Progress line: drives the bar, and is left out of the kept tail (noise).
      const pct = parseFloat(m[1])
      if (pct !== lastPct) {
        lastPct = pct
        opts.onProgress?.(pct)
      }
      return
    }
    recentLines.push(line)
    if (recentLines.length > MAX_LOG_LINES) recentLines.shift()
  })

  child.stdout.on('data', lineBuffer.feed)
  child.stderr.on('data', lineBuffer.feed)

  try {
    await waitForExit(child, { command: 'yt-dlp download' })
  } catch (err) {
    lineBuffer.flush()
    // No auto-retry: a stall or a clean failure both terminate here. Attach
    // yt-dlp's recent output so the failure panel shows what went wrong (where
    // it stalled, or the actual error), not just an exit code.
    const detail = recentLines.join('\n').trim()
    const base = err instanceof Error ? err.message : String(err)
    throw new Error(detail ? `${base}\n\n${detail}` : base)
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

/**
 * Remove yt-dlp's in-progress artifacts (.part / .ytdl / .frag) for a video id.
 * Resuming a stale or oversized .part is what triggers HTTP 416 ("range not
 * satisfiable") on a retry, so a failed item's partials are cleared before it
 * runs again. Completed per-format streams are left for yt-dlp to reuse.
 */
export async function clearPartials(libraryDir: string, outputId: string): Promise<void> {
  let entries: string[]
  try {
    entries = await readdir(libraryDir)
  } catch {
    return
  }
  for (const name of entries) {
    if (!name.startsWith(`${outputId}.`)) continue
    if (name.endsWith('.part') || name.endsWith('.ytdl') || /\.frag\d*$/.test(name)) {
      await unlink(join(libraryDir, name)).catch(() => {})
    }
  }
}
