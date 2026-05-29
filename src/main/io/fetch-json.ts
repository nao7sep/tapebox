import { getSettings } from '@main/store/config'
import { withRetry, withRequestTimeout } from './retry'

/**
 * GET + parse JSON under the 'metadata' network policy: per-attempt request
 * timeout plus retries with jittered backoff. Used for the small upstream
 * lookups (GitHub releases, evermeet ffmpeg info).
 */
export async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  const policy = getSettings().network.lookups
  return withRetry(policy, () =>
    withRequestTimeout(policy.timeoutMs, undefined, async (signal) => {
      const res = await fetch(url, { ...init, signal })
      if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText} for ${url}`)
      return res.json() as Promise<T>
    }),
  )
}
