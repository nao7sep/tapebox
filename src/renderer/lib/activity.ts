import type { Tape } from '@shared/domain'
import type { ProgressEntry } from '@renderer/store/tapes'

export type ActivitySummary = {
  downloading: number
  queued: number
  paused: number
  failed: number
  listing: number
  totalSpeedBps: number
  etaSec: number | null
}

/**
 * Collapse the tape pipeline into the numbers the status bar shows. `queued`
 * folds the three pre-download working states (queued/probing/ready) — the user
 * only cares that they're waiting to land. `paused` and `failed` and `listing`
 * are the states that ask for the user: paused won't start on its own, failed
 * needs a retry, listing is a page of videos to scan. They used to surface by
 * jumping the list; now the bar is where they're noticed, so they're counted
 * here. Speed sums the active downloads' live rates; ETA is the longest remaining
 * among them, i.e. when the current in-flight set finishes — waiting tapes
 * deliberately don't inflate it.
 */
export function summarizeActivity(
  tapes: Tape[],
  progress: Record<string, ProgressEntry | undefined>,
): ActivitySummary {
  let downloading = 0
  let queued = 0
  let paused = 0
  let failed = 0
  let listing = 0
  let totalSpeedBps = 0
  let etaSec: number | null = null

  for (const tape of tapes) {
    switch (tape.state) {
      case 'downloading': {
        downloading++
        const p = progress[tape.id]
        if (p?.speedBps) totalSpeedBps += p.speedBps
        if (p?.etaSec != null) etaSec = etaSec == null ? p.etaSec : Math.max(etaSec, p.etaSec)
        break
      }
      case 'queued':
      case 'probing':
      case 'ready':
        queued++
        break
      case 'paused':
        paused++
        break
      case 'failed':
        failed++
        break
      case 'listing':
        listing++
        break
    }
  }

  return { downloading, queued, paused, failed, listing, totalSpeedBps, etaSec }
}
