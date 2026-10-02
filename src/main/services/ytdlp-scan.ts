import { binaryPath } from '@main/paths'
import { log } from '@main/io/logger'
import { YTDLP_PROBE_IDLE_TIMEOUT_MS } from '@main/io/network'
import {
  makeLineBuffer,
  spawnStreaming,
  SubprocessError,
  waitForExit,
} from '@main/io/spawn'
import { errorMessage } from '@shared/error'
import { collectRun, ytdlpEnv } from './ytdlp'
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
  /** yt-dlp's extractor key for the entry (`ie_key`), when the listing names it. */
  extractor: string | null
  url: string
  title: string | null
  duration: number | null
  uploadDate: string | null
  thumbnailUrl: string | null
}

/**
 * How a scan ended. `stopped` is a cancel (the user's Stop, closing the dialog, or
 * quitting), never a failure. A scan that listed entries before yt-dlp failed keeps
 * them as `done`; one that failed with nothing listed is `failed`.
 */
export type ScanOutcome =
  | { kind: 'done'; totalCount: number }
  | { kind: 'stopped'; totalCount: number }
  | { kind: 'failed'; error: unknown }

export type ScanHandle = {
  cancel: () => void
  /** Always resolves; a failure is an outcome, not a rejection. */
  complete: Promise<ScanOutcome>
}

/** Decide a finished scan's outcome from how yt-dlp ended and what it listed. */
export function scanOutcome(ended: {
  aborted: boolean
  failure: unknown
  exitCode: number | null
  totalCount: number
  stderr: string
}): ScanOutcome {
  const { aborted, failure, exitCode, totalCount } = ended
  if (aborted) return { kind: 'stopped', totalCount }
  if ((failure === null && exitCode === 0) || totalCount > 0) return { kind: 'done', totalCount }
  return { kind: 'failed', error: failure ?? new SubprocessError(SCAN_COMMAND, exitCode, ended.stderr) }
}

const SCAN_COMMAND = 'yt-dlp enum'

export function startScan(
  url: string,
  scanId: string,
  onEntry: (entry: ScannedEntry) => void,
): ScanHandle {
  const ctl = new AbortController()
  const args = [...resolveYtdlpArgs(url), '--flat-playlist', '-j', '--no-warnings', url]
  const child = spawnStreaming(
    binaryPath('yt-dlp'),
    args,
    { env: ytdlpEnv(), signal: ctl.signal, idleTimeoutMs: YTDLP_PROBE_IDLE_TIMEOUT_MS },
  )
  const run = collectRun(child, { kind: 'scan', tapeId: null, scanId, url, args })

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

  const complete = (async (): Promise<ScanOutcome> => {
    let exitCode: number | null = null
    let failure: unknown = null
    try {
      exitCode = await waitForExit(child, { reject: false, command: SCAN_COMMAND })
    } catch (err) {
      failure = err
    } finally {
      lineBuffer.flush()
      run.record()
    }
    // yt-dlp states why it failed on stderr.
    return scanOutcome({ aborted: ctl.signal.aborted, failure, exitCode, totalCount: total, stderr: run.stderr() })
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
    extractor: typeof info['ie_key'] === 'string' ? info['ie_key'] : null,
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
