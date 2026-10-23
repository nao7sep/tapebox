import { StringDecoder } from 'node:string_decoder'
import { binaryPath } from '@main/paths'
import { log } from '@main/io/logger'
import { YTDLP_PROBE_IDLE_TIMEOUT_MS } from '@main/io/network'
import {
  spawnStreaming,
  SubprocessError,
  waitForExit,
} from '@main/io/spawn'
import { errorMessage } from '@shared/error'
import { StopRequest, type StopCause } from '@main/stop-request'
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
 * quitting), never a failure. A failed scan remains failed even when entries were already delivered;
 * the caller keeps those entries usable.
 */
export type ScanOutcome =
  | { kind: 'done'; totalCount: number }
  | { kind: 'stopped'; totalCount: number }
  | { kind: 'failed'; error: unknown }

export type ScanHandle = {
  cancel: (by: StopCause) => void
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
  outputKey?: string
}): ScanOutcome {
  const { aborted, failure, exitCode, totalCount } = ended
  if (aborted) return { kind: 'stopped', totalCount }
  if (failure === null && exitCode === 0) return { kind: 'done', totalCount }
  return { kind: 'failed', error: failure ?? new SubprocessError(SCAN_COMMAND, exitCode, ended.stderr, ended.outputKey) }
}

const SCAN_COMMAND = 'yt-dlp enum'

export function startScan(
  url: string,
  scanId: string,
  onEntry: (entry: ScannedEntry) => void | Promise<void>,
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

  let stopped = false
  // Register exit ownership before consuming output: a fast child can close
  // while its final entry is still being written to the result store.
  const exited = waitForExit(child, { reject: false, command: SCAN_COMMAND })
    .then(code => ({ code, error: null }), error => ({ code: null, error }))
  const consume = async (line: string): Promise<void> => {
    if (!line) return
    let info: Record<string, unknown>
    try { info = JSON.parse(line) as Record<string, unknown> }
    catch (err) {
      log.debug('scan: bad json line', { reason: errorMessage(err) })
      return
    }
    if (!info || typeof info !== 'object' || Array.isArray(info)) return
    const entry = parseEntry(info)
    if (entry) { await onEntry(entry); total++ }
  }
  const complete = (async (): Promise<ScanOutcome> => {
    let failure: unknown = null
    const decoder = new StringDecoder('utf8')
    let remainder = ''
    try {
      // Await each stored entry before reading again. The pipe supplies physical
      // backpressure even when the window is hidden or has stopped polling.
      for await (const chunk of child.stdout) {
        remainder += decoder.write(chunk as Buffer)
        let end: number
        while ((end = remainder.indexOf('\n')) !== -1) {
          const line = remainder.slice(0, end).replace(/\r$/, '')
          remainder = remainder.slice(end + 1)
          await consume(line)
        }
      }
      remainder += decoder.end()
      if (remainder) await consume(remainder.replace(/\r$/, ''))
    } catch (error) {
      failure = error
      ctl.abort(error)
    }
    const ended = await exited
    run.record()
    return scanOutcome({ aborted: stopped, failure: failure ?? ended.error, exitCode: ended.code, totalCount: total, stderr: run.stderr(), outputKey: run.outputKey })
  })()

  return {
    cancel: (by) => { stopped = true; ctl.abort(new StopRequest(by)) },
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
