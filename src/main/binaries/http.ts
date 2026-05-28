import { createWriteStream } from 'node:fs'

/**
 * Download a URL to a destination path with progress callbacks.
 * Uses the built-in fetch API (Node 18+). Streams to disk to avoid
 * buffering the whole file in memory.
 */
export type DownloadOptions = {
  url: string
  destPath: string
  onProgress?: (received: number, total: number) => void
  signal?: AbortSignal
}

export async function downloadWithProgress(opts: DownloadOptions): Promise<void> {
  const res = await fetch(opts.url, { signal: opts.signal, redirect: 'follow' })
  if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText} from ${opts.url}`)
  if (!res.body) throw new Error(`Response body missing from ${opts.url}`)

  const total = Number(res.headers.get('content-length') ?? 0)
  let received = 0

  const out = createWriteStream(opts.destPath)
  const reader = res.body.getReader()

  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
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
}
