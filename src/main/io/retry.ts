import type { RetryPolicy } from '@shared/settings'

/**
 * Generic retry + timeout primitives for network work. Pure and app-agnostic:
 * the policy is supplied by the caller (from settings), and the per-attempt
 * timeout mechanism (request deadline vs idle watchdog) is the attempt's job —
 * withRetry only owns the loop, intervals, jitter, and cancellation.
 */

export type RetryHooks = {
  /** Caller cancellation. An abort here stops retrying immediately. */
  signal?: AbortSignal
  /** Return false to treat an error as permanent (no further retries). */
  isRetryable?: (err: unknown) => boolean
  onRetry?: (info: { attempt: number; delayMs: number; error: unknown }) => void
}

export async function withRetry<T>(
  policy: RetryPolicy,
  attempt: () => Promise<T>,
  hooks: RetryHooks = {},
): Promise<T> {
  for (let i = 0; ; i++) {
    hooks.signal?.throwIfAborted()
    try {
      return await attempt()
    } catch (err) {
      // Caller cancellation always wins over the retry schedule.
      if (hooks.signal?.aborted) throw err
      const canRetry = i < policy.intervals.length && (hooks.isRetryable?.(err) ?? true)
      if (!canRetry) throw err
      const delayMs = jitter(policy.intervals[i]!, policy.jitterRatio)
      hooks.onRetry?.({ attempt: i + 1, delayMs, error: err })
      await sleep(delayMs, hooks.signal)
    }
  }
}

/**
 * Run fn with a per-attempt request deadline. Combines the caller's signal (if
 * any) with a fresh timeout signal, so fn aborts on whichever fires first.
 * On timeout the rejection is a DOMException named 'TimeoutError'.
 */
export function withRequestTimeout<T>(
  timeoutMs: number,
  parentSignal: AbortSignal | undefined,
  fn: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const signal = parentSignal
    ? AbortSignal.any([parentSignal, AbortSignal.timeout(timeoutMs)])
    : AbortSignal.timeout(timeoutMs)
  return fn(signal)
}

function jitter(intervalMs: number, ratio: number): number {
  const delta = intervalMs * ratio * (Math.random() * 2 - 1)
  return Math.max(0, Math.round(intervalMs + delta))
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason)
    const timer = setTimeout(() => {
      cleanup()
      resolve()
    }, ms)
    const onAbort = () => {
      cleanup()
      reject(signal!.reason)
    }
    const cleanup = () => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}
