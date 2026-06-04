import { dirname, extname, join } from 'node:path'
import { readdir, unlink } from 'node:fs/promises'
import { binaryPath, paths } from '@main/paths'
import { resolveYtdlpArgs } from './ytdlp-args'
import { YTDLP_PROBE_IDLE_TIMEOUT_MS } from '@main/io/network'
import {
  execCapture,
  makeLineBuffer,
  spawnStreaming,
  SubprocessError,
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
  uploader: string | null
  duration: number | null
  thumbnail: string | null
  chapters: ProbeChapter[] | null
}
/** A single video to download, or a page of videos the caller should reject. */
export type ProbeResult = ProbeVideo | { kind: 'page' }

/**
 * Single-video probe. Returns the parsed video info, or { kind: 'page' }
 * when the URL is a page that lists videos rather than one video.
 *
 * The flags do double duty: --dump-single-json yields one JSON object whose
 * _type is 'playlist' for a page of videos and 'video' for a single video, so
 * the kind is a field read, not a parse heuristic. --flat-playlist + --playlist-items 1
 * keep detection O(1): yt-dlp reports the kind without extracting the whole
 * page (extracting every entry is what used to wedge the queue forever).
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
  if (info['_type'] === 'playlist') return { kind: 'page' }

  return {
    kind: 'video',
    id: String(info['id'] ?? ''),
    // Whatever language yt-dlp returns the title in is the one we keep; a user can
    // steer it with an Accept-Language header via global args or a site profile.
    title: String(info['title'] ?? ''),
    uploader: stringOrNull(info['uploader'] ?? info['channel']),
    duration: typeof info['duration'] === 'number' ? info['duration'] : null,
    thumbnail: stringOrNull(info['thumbnail']),
    chapters: Array.isArray(info['chapters']) ? (info['chapters'] as ProbeChapter[]) : null,
  }
}

function stringOrNull(v: unknown): string | null {
  return typeof v === 'string' ? v : null
}

export type DownloadProgress = {
  percent: number
  speedBps?: number // bytes/sec; absent until yt-dlp can estimate it
  etaSec?: number // seconds remaining; absent until yt-dlp can estimate it
}

export type DownloadOptions = {
  url: string
  libraryDir: string
  outputId: string
  onProgress?: (progress: DownloadProgress) => void
  /** Each meaningful yt-dlp output line (progress lines and our markers excluded). */
  onLog?: (line: string) => void
  signal: AbortSignal
}

export type DownloadResult = {
  mediaPath: string
  infoJsonPath: string
}

const FINAL_PATH_MARKER = 'tapebox-final-filepath:'

/**
 * Our --progress-template marker. We drive progress from a template we control
 * rather than scraping yt-dlp's human-formatted "[download] X%" line: the
 * template gives raw numeric speed/eta (and yt-dlp's own percent, correct for
 * fragmented HLS/DASH where byte totals are unknown).
 */
const PROGRESS_MARKER = 'tapebox-progress:'

/** How many recent yt-dlp output lines to keep so a failure can show what it said. */
const MAX_LOG_LINES = 60

/** Parse a --progress-template number; its 'NA' placeholder becomes undefined. */
function finiteOrUndefined(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined
  const n = parseFloat(raw)
  return Number.isFinite(n) ? n : undefined
}

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
      '--progress-template',
      `download:${PROGRESS_MARKER}%(progress._percent_str)s|%(progress.speed)s|%(progress.eta)s`,
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
    if (line.startsWith(PROGRESS_MARKER)) {
      // Our progress-template line: percent|speed(B/s)|eta(s). Drives the bar and
      // is left out of the kept tail (noise). Speed/eta are 'NA' until estimable.
      const [pctRaw, speedRaw, etaRaw] = line.slice(PROGRESS_MARKER.length).split('|')
      const percent = parseFloat(pctRaw)
      if (Number.isFinite(percent) && percent !== lastPct) {
        lastPct = percent
        opts.onProgress?.({
          percent,
          speedBps: finiteOrUndefined(speedRaw),
          etaSec: finiteOrUndefined(etaRaw),
        })
      }
      return
    }
    recentLines.push(line)
    if (recentLines.length > MAX_LOG_LINES) recentLines.shift()
    // Same lines the failure tail keeps, but streamed live so the UI can show
    // progress as it happens. Markers and progress lines already returned above.
    opts.onLog?.(line)
  })

  child.stdout.on('data', lineBuffer.feed)
  child.stderr.on('data', lineBuffer.feed)

  try {
    await waitForExit(child, { command: 'yt-dlp download' })
  } catch (err) {
    lineBuffer.flush()
    // No auto-retry: a stall or a clean failure both terminate here. yt-dlp's
    // own recent output (recentLines) is the real error text — waitForExit's
    // SubprocessError carries an empty stderr since the stream was parsed live.
    // Re-throw it as a SubprocessError carrying that output, so the failure
    // stays structured (command/exitCode/stderr) for the queue and the log
    // rather than collapsing into one opaque string.
    const detail = recentLines.join('\n').trim()
    if (err instanceof SubprocessError) {
      throw new SubprocessError(err.command, err.exitCode, detail || err.stderr)
    }
    throw err
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
 * satisfiable") on a retry, so a failed tape's partials are cleared before it
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
