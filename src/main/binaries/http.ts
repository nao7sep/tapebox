import { createWriteStream } from 'node:fs'
import { Readable, Transform, type Writable } from 'node:stream'
import type { ReadableStream as WebReadableStream } from 'node:stream/web'
import { pipeline } from 'node:stream/promises'
import { IdleTimeoutError } from '@main/io/spawn'
import { assertHttpsUrl } from '@main/io/network'

/**
 * Download a URL to a destination path with progress callbacks.
 * Uses the built-in fetch API (Node 18+). Streams to disk via stream.pipeline,
 * which owns backpressure, error propagation, and stream teardown — so a failed
 * write rejects (and destroys both ends) instead of stranding a manual drain
 * await, and the whole file never has to sit in memory.
 *
 * idleTimeoutMs guards liveness across the whole transfer: an IdleTimeoutError
 * aborts the download if nothing makes progress for that long — first while
 * waiting for response headers (a stalled connect), then between body chunks (a
 * stalled transfer). The same `idleWatchdog` drives both phases.
 */
export type DownloadOptions = {
  url: string
  destPath: string
  onProgress?: (received: number, total: number) => void
  signal?: AbortSignal
  idleTimeoutMs?: number
}

export async function downloadWithProgress(opts: DownloadOptions): Promise<void> {
  // These bytes are written to ~/.tapebox/bin and then executed, so refuse anything
  // but https up front — a plain-http download URL (from a registry bug or a
  // downgrade) must never reach the network here.
  assertHttpsUrl(opts.url, 'binary download')

  // Connect phase: bound the wait for response headers. The watchdog aborts the
  // fetch signal; undici rejects fetch with the abort reason, so a stalled
  // connect surfaces as the same IdleTimeoutError a stalled transfer does.
  const connect = new AbortController()
  const signal = opts.signal ? AbortSignal.any([opts.signal, connect.signal]) : connect.signal
  const watch = idleWatchdog(opts.url, opts.idleTimeoutMs, (err) => connect.abort(err))

  let res: Response
  watch.kick()
  try {
    res = await fetch(opts.url, { signal, redirect: 'follow' })
  } finally {
    watch.clear()
  }

  assertHttpsUrl(res.url, 'binary download response')

  if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText} from ${opts.url}`)
  if (!res.body) throw new Error(`Response body missing from ${opts.url}`)

  const total = Number(res.headers.get('content-length') ?? 0)
  const out = createWriteStream(opts.destPath)
  await pumpToFile(res.body, out, {
    total,
    url: opts.url,
    idleTimeoutMs: opts.idleTimeoutMs,
    signal: opts.signal,
    onProgress: opts.onProgress,
  })
}

/**
 * Stream a web ReadableStream to a Node Writable, reporting cumulative bytes and
 * enforcing a per-chunk idle watchdog. Exported so the streaming edge cases
 * (write error, source error, backpressure, idle, cancellation) are unit-testable
 * without a network or the filesystem.
 *
 * pipeline propagates an error from any stage as a rejection and destroys every
 * stream, so there is no manual write/drain loop to strand. The idle watchdog
 * destroys the source with an IdleTimeoutError, which pipeline surfaces verbatim.
 *
 * The watchdog is kicked as each chunk is pulled from the source. Under write
 * backpressure a chunk is pulled only once the previous write drains, so a
 * steady transfer — slow network OR slow disk — keeps re-arming it; it trips only
 * when a single read-or-write stalls past idleTimeoutMs, which is the hung-transfer
 * liveness guard we want (a wall-clock cap would instead kill slow-but-alive
 * downloads).
 */
export async function pumpToFile(
  body: ReadableStream<Uint8Array>,
  out: Writable,
  opts: {
    total: number
    url: string
    idleTimeoutMs?: number
    signal?: AbortSignal
    onProgress?: (received: number, total: number) => void
  },
): Promise<void> {
  // fetch() yields the global ReadableStream<Uint8Array>, but Readable.fromWeb is
  // typed for stream/web's ReadableStream<any>. They are the same runtime class —
  // the mismatch is a known @types/node generic-variance wart — so bridge it with
  // one precise assertion. fromWeb (rather than Readable.from over the async
  // iterator) because it cancels the reader on destroy, which is what lets the idle
  // watchdog and a caller abort interrupt a transfer that is parked mid-read.
  const source = Readable.fromWeb(body as WebReadableStream)
  const watch = idleWatchdog(opts.url, opts.idleTimeoutMs, (err) => source.destroy(err))

  let received = 0
  const counter = new Transform({
    transform(chunk: Buffer, _enc, cb) {
      received += chunk.byteLength
      watch.kick()
      opts.onProgress?.(received, opts.total)
      cb(null, chunk)
    },
  })

  watch.kick() // cover the gap before the first chunk arrives
  try {
    await pipeline(source, counter, out, { signal: opts.signal })
  } finally {
    watch.clear()
  }
}

/**
 * A resettable idle watchdog. `kick()` (re)arms a timer that calls `onIdle` with a
 * fresh IdleTimeoutError if it isn't kicked again within idleTimeoutMs; `clear()`
 * cancels it. A null idleTimeoutMs disables the watchdog (kick/clear are no-ops),
 * so callers don't special-case "no timeout". The action is the caller's — aborting
 * a fetch, destroying a stream — so one timer shape serves both download phases.
 */
function idleWatchdog(
  url: string,
  idleTimeoutMs: number | undefined,
  onIdle: (err: IdleTimeoutError) => void,
): { kick: () => void; clear: () => void } {
  let timer: NodeJS.Timeout | null = null
  return {
    kick() {
      if (idleTimeoutMs == null) return
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => onIdle(new IdleTimeoutError(url, idleTimeoutMs)), idleTimeoutMs)
    },
    clear() {
      if (timer) clearTimeout(timer)
      timer = null
    },
  }
}
