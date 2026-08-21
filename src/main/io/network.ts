import type { RetryPolicy } from './retry'

/**
 * Network behavior constants.
 *
 * These were briefly user-configurable (a per-group timeout/retry/interval/
 * jitter matrix in Settings), but that was over-built for a single-user desktop
 * app: the right timeout and retry counts are engineering decisions, not user
 * preferences, and a backoff schedule has no place in product UI. The one knob
 * users actually want — extra yt-dlp args / per-site profiles — lives in
 * Settings → yt-dlp.
 */

/**
 * Idle watchdog for yt-dlp probe + page scan: kill a silently
 * stalled process so the queue never hangs. It's a stall guard, not a request
 * deadline — a healthy probe only has to keep emitting output. yt-dlp work is
 * never auto-retried (re-hitting a media site risks an IP block), so a failure
 * surfaces for a manual retry.
 */
export const YTDLP_PROBE_IDLE_TIMEOUT_MS = 30_000

/** Per-attempt request deadline for the small upstream lookups (GitHub releases, the martin-riedl ffmpeg redirect, sums files). */
export const VERSION_CHECK_TIMEOUT_MS = 30_000

/** Idle watchdog for binary downloads from GitHub — guards against a stalled transfer. */
export const BINARY_DOWNLOAD_IDLE_TIMEOUT_MS = 60_000

/** Per-attempt request deadline for AI provider calls (slug generation). */
export const AI_REQUEST_TIMEOUT_MS = 120_000

/**
 * Retry schedule for transient failures against well-behaved HTTP endpoints
 * (GitHub, the ffmpeg build hosts, the AI provider) — 429/5xx and connection blips, safe to
 * retry. No jitter: jitter decorrelates many clients hitting one server, and
 * there is only ever one client here.
 */
export const HTTP_RETRY: RetryPolicy = {
  retries: 3,
  intervals: [2_000, 5_000, 15_000],
}

export class UnsafeUrlError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'UnsafeUrlError'
  }
}

const HTTPS_REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308])
const MAX_HTTPS_REDIRECTS = 10

/** A URL-policy failure is deterministic; retrying the same downgrade only
 * delays the refusal. */
export function isRetryableHttpFailure(err: unknown): boolean {
  return !(err instanceof UnsafeUrlError)
}

/**
 * Refuse any non-https URL before it reaches the network. Every managed-binary
 * request — the binary download, the GitHub release metadata, the vendor redirect,
 * and the checksum sums file — is security-critical (the bytes end up executable, or
 * decide whether those bytes are trusted), so the whole channel is https-only. A
 * plain-http URL from a downgrade, a redirect Location, or a bug is rejected here,
 * not just on the download leg. `context` names the leg for the error message.
 */
export function assertHttpsUrl(url: string, context: string): void {
  let scheme = ''
  try {
    scheme = new URL(url).protocol
  } catch {
    throw new UnsafeUrlError(`invalid ${context} URL: ${url}`)
  }
  if (scheme !== 'https:') {
    throw new UnsafeUrlError(`refusing non-https ${context} URL: ${url}`)
  }
}

/**
 * Fetch an HTTPS resource while validating every redirect hop before it reaches
 * the network. Checking only Response.url after redirect:'follow' is insufficient:
 * an https -> http -> https chain finishes on HTTPS while still exposing one hop
 * to plaintext interception. All current callers are GETs, so redirect method/body
 * rewriting is deliberately outside this helper's surface.
 */
export async function fetchHttps(
  url: string,
  init: RequestInit | undefined,
  context: string,
): Promise<Response> {
  let current = url
  for (let redirects = 0; ; redirects += 1) {
    assertHttpsUrl(current, context)
    const res = await fetch(current, { ...init, redirect: 'manual' })
    // A manual redirect must leave us on the URL we chose. Keep this check as a
    // defence against runtime/proxy behavior that reports a different effective URL.
    assertHttpsUrl(res.url, `${context} response`)

    if (!HTTPS_REDIRECT_STATUSES.has(res.status)) return res
    let next: string
    try {
      const location = res.headers.get('location')
      if (!location) {
        throw new Error(`HTTP ${res.status} redirect from ${current} has no Location header`)
      }
      if (redirects >= MAX_HTTPS_REDIRECTS) {
        throw new Error(`too many redirects while fetching ${url}`)
      }
      next = new URL(location, res.url || current).toString()
      assertHttpsUrl(next, `${context} redirect`)
    } finally {
      // We do not consume redirect bodies. Explicit cancellation releases their
      // connection/resources before either following or rejecting the next hop.
      await res.body?.cancel().catch(() => {})
    }
    current = next
  }
}
