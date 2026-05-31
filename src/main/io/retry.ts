/**
 * Generic retry + timeout primitives for network work. Pure and app-agnostic:
 * the policy is a code-level constant supplied by the caller, and the per-attempt
 * timeout mechanism (request deadline vs idle watchdog) is the attempt's job —
 * withRetry only owns the loop, intervals, and cancellation.
 */

export type RetryPolicy = {
  /** Retry attempts after the first failure (total attempts = retries + 1). */
  retries: number
  /**
   * Wait-before-retry schedule in ms. If retries exceeds its length the last
   * value is reused; an empty schedule means retry immediately.
   */
  intervals: number[]
}

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
      const canRetry = i < policy.retries && (hooks.isRetryable?.(err) ?? true)
      if (!canRetry) throw err
      const delayMs = intervalAt(policy.intervals, i)
      hooks.onRetry?.({ attempt: i + 1, delayMs, error: err })
      await sleep(delayMs, hooks.signal)
    }
  }
}

/**
 * The interval for retry attempt i. When retries exceeds intervals.length we
 * keep reusing the last interval, so e.g. retries=5 with intervals=[1s, 3s]
 * gives [1s, 3s, 3s, 3s, 3s]. An empty schedule means 0ms (immediate retry).
 */
function intervalAt(intervals: number[], i: number): number {
  if (intervals.length === 0) return 0
  return intervals[Math.min(i, intervals.length - 1)]!
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
