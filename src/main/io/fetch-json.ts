import { withRetry, withRequestTimeout } from './retry'
import {
  HTTP_RETRY,
  VERSION_CHECK_TIMEOUT_MS,
  assertHttpsUrl,
  fetchHttps,
  isRetryableHttpFailure,
} from './network'

/**
 * GET + parse JSON with a per-attempt request timeout plus retries with backoff.
 * Used for the small upstream lookups (GitHub release metadata) —
 * safe to retry, no block risk. https-only, like every managed-binary request.
 */
export async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  assertHttpsUrl(url, 'metadata')
  return withRetry(
    HTTP_RETRY,
    () =>
      withRequestTimeout(VERSION_CHECK_TIMEOUT_MS, init?.signal ?? undefined, async (signal) => {
        const res = await fetchHttps(url, { ...init, signal }, 'metadata')
        if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText} for ${url}`)
        return res.json() as Promise<T>
      }),
    { signal: init?.signal ?? undefined, isRetryable: isRetryableHttpFailure },
  )
}

/**
 * GET + return the response body as text, same retry/timeout policy as fetchJson.
 * Used for small upstream text lookups such as a `SHA2-256SUMS` checksum file — the
 * integrity channel, so it is https-only too (a downgraded sums fetch would let an
 * attacker serve a matching checksum).
 */
export async function fetchText(url: string, init?: RequestInit): Promise<string> {
  assertHttpsUrl(url, 'checksum')
  return withRetry(
    HTTP_RETRY,
    () =>
      withRequestTimeout(VERSION_CHECK_TIMEOUT_MS, init?.signal ?? undefined, async (signal) => {
        const res = await fetchHttps(url, { ...init, signal }, 'checksum')
        if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText} for ${url}`)
        return res.text()
      }),
    { signal: init?.signal ?? undefined, isRetryable: isRetryableHttpFailure },
  )
}

/**
 * GET a URL WITHOUT following redirects and return its Location header verbatim
 * (which may be a relative path — the caller resolves it). Same retry/timeout policy
 * as fetchJson. Used to resolve a vendor's stable "latest" redirect to a concrete
 * versioned URL (martin-riedl's ffmpeg, which exposes no JSON API). https-only.
 */
export async function fetchRedirectLocation(url: string, init?: RequestInit): Promise<string> {
  assertHttpsUrl(url, 'redirect')
  return withRetry(
    HTTP_RETRY,
    () =>
      withRequestTimeout(VERSION_CHECK_TIMEOUT_MS, init?.signal ?? undefined, async (signal) => {
        const res = await fetch(url, { ...init, redirect: 'manual', signal })
        assertHttpsUrl(res.url, 'redirect response')
        const location = res.headers.get('location')
        if (!location) {
          throw new Error(`expected a redirect with a Location header from ${url} (got HTTP ${res.status})`)
        }
        return location
      }),
    { signal: init?.signal ?? undefined, isRetryable: isRetryableHttpFailure },
  )
}
