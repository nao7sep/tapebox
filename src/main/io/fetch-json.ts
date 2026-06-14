import { withRetry, withRequestTimeout } from './retry'
import { HTTP_RETRY, VERSION_CHECK_TIMEOUT_MS } from './network'

/**
 * GET + parse JSON with a per-attempt request timeout plus retries with backoff.
 * Used for the small upstream lookups (GitHub releases, evermeet ffmpeg info) —
 * safe to retry, no block risk.
 */
export async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  return withRetry(HTTP_RETRY, () =>
    withRequestTimeout(VERSION_CHECK_TIMEOUT_MS, undefined, async (signal) => {
      const res = await fetch(url, { ...init, signal })
      if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText} for ${url}`)
      return res.json() as Promise<T>
    }),
  )
}

/**
 * GET + return the response body as text, same retry/timeout policy as fetchJson.
 * Used for small upstream text lookups such as a `SHA2-256SUMS` checksum file.
 */
export async function fetchText(url: string, init?: RequestInit): Promise<string> {
  return withRetry(HTTP_RETRY, () =>
    withRequestTimeout(VERSION_CHECK_TIMEOUT_MS, undefined, async (signal) => {
      const res = await fetch(url, { ...init, signal })
      if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText} for ${url}`)
      return res.text()
    }),
  )
}
