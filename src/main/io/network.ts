import type { RetryPolicy } from './retry'

/**
 * Network behavior constants.
 *
 * These were briefly user-configurable (a per-box timeout/retry/interval/
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

/** Per-attempt request deadline for the small upstream JSON lookups (GitHub releases, evermeet ffmpeg info). */
export const VERSION_CHECK_TIMEOUT_MS = 30_000

/** Idle watchdog for binary downloads from GitHub — guards against a stalled transfer. */
export const BINARY_DOWNLOAD_IDLE_TIMEOUT_MS = 60_000

/** Per-attempt request deadline for AI provider calls (slug generation). */
export const AI_REQUEST_TIMEOUT_MS = 120_000

/**
 * Retry schedule for transient failures against well-behaved HTTP endpoints
 * (GitHub, evermeet, the AI provider) — 429/5xx and connection blips, safe to
 * retry. No jitter: jitter decorrelates many clients hitting one server, and
 * there is only ever one client here.
 */
export const HTTP_RETRY: RetryPolicy = {
  retries: 3,
  intervals: [2_000, 5_000, 15_000],
}
