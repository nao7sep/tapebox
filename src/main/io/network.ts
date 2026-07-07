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
    throw new Error(`invalid ${context} URL: ${url}`)
  }
  if (scheme !== 'https:') {
    throw new Error(`refusing non-https ${context} URL: ${url}`)
  }
}
