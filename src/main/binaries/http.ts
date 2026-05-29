import { createWriteStream } from 'node:fs'
import { IdleTimeoutError } from '@main/io/spawn'

/**
 * Download a URL to a destination path with progress callbacks.
 * Uses the built-in fetch API (Node 18+). Streams to disk to avoid
 * buffering the whole file in memory.
 *
 * idleTimeoutMs guards against a stalled connection: if no bytes arrive for
 * that long, the fetch is aborted with an IdleTimeoutError (resets on each
 * chunk, so a slow-but-alive transfer isn't killed).
 */
export type DownloadOptions = {
  url: string
  destPath: string
  onProgress?: (received: number, total: number) => void
  signal?: AbortSignal
  idleTimeoutMs?: number
}

export async function downloadWithProgress(opts: DownloadOptions): Promise<void> {
  const stall = new AbortController()
  const signal = opts.signal ? AbortSignal.any([opts.signal, stall.signal]) : stall.signal

  let idleTimer: NodeJS.Timeout | null = null
  const kickIdle = () => {
    if (opts.idleTimeoutMs == null) return
    if (idleTimer) clearTimeout(idleTimer)
    idleTimer = setTimeout(() => stall.abort(new IdleTimeoutError(opts.url, opts.idleTimeoutMs!)), opts.idleTimeoutMs)
  }
  const stopIdle = () => {
    if (idleTimer) clearTimeout(idleTimer)
    idleTimer = null
  }

  kickIdle()
  try {
    const res = await fetch(opts.url, { signal, redirect: 'follow' })
    if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText} from ${opts.url}`)
    if (!res.body) throw new Error(`Response body missing from ${opts.url}`)

    const total = Number(res.headers.get('content-length') ?? 0)
    let received = 0

    const out = createWriteStream(opts.destPath)
    out.on('error', () => { /* propagated via end() callback below */ })
    const reader = res.body.getReader()

    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        kickIdle()
        received += value.byteLength
        if (!out.write(value)) {
          await new Promise<void>((resolve) => out.once('drain', () => resolve()))
        }
        opts.onProgress?.(received, total)
      }
    } finally {
      await new Promise<void>((resolve, reject) => {
        out.end((err?: Error | null) => (err ? reject(err) : resolve()))
      })
    }
  } finally {
    stopIdle()
  }
}
