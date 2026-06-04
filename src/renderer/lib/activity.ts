import type { Tape } from '@shared/domain'
import type { ProgressEntry } from '@renderer/store/tapes'

export type ActivitySummary = {
  downloading: number
  queued: number
  failed: number
  totalSpeedBps: number
  etaSec: number | null
}

/**
 * Collapse the tape pipeline into the numbers the status bar shows. `queued`
 * folds the three pre-download working states (queued/probing/ready) — the user
 * only cares that they're waiting to land. Speed sums the active downloads' live
 * rates; ETA is the longest remaining among them, i.e. when the current
 * in-flight set finishes — waiting tapes deliberately don't inflate it.
 */
export function summarizeActivity(
  tapes: Tape[],
  progress: Record<string, ProgressEntry | undefined>,
): ActivitySummary {
  let downloading = 0
  let queued = 0
  let failed = 0
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
      case 'failed':
        failed++
        break
    }
  }

  return { downloading, queued, failed, totalSpeedBps, etaSec }
}
