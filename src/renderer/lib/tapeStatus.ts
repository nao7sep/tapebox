import type { Tape, TapeState } from '@shared/domain'
import type { ProgressEntry } from '@renderer/store/tapes'

/**
 * Title-case label for each tape state. Module-private: callers go through
 * tapeStatusLabel() below (which layers live progress on top), so a tape reads
 * the same wherever it appears (no stray lowercase).
 */
const TAPE_STATE_LABEL: Record<TapeState, string> = {
  queued: 'Queued',
  probing: 'Probing',
  ready: 'Ready',
  downloading: 'Downloading',
  downloaded: 'In library',
  failed: 'Failed',
  paused: 'Paused',
  listing: 'Video list',
}

/**
 * True while the app is actively working on this tape — probing, the brief
 * hand-off to a download, or downloading — so the UI shows a moving "working"
 * bar. 'queued' is deliberately excluded: a queued tape is waiting for a free
 * slot, not being processed, so it stays still rather than implying activity.
 * (StatusBar tracks whole-queue liveness separately, at the app level.)
 */
export function isProcessing(state: TapeState): boolean {
  return state === 'probing' || state === 'ready' || state === 'downloading'
}

/**
 * A tape's status as one short phrase: live progress while downloading or
 * probing, otherwise the plain state label.
 */
export function tapeStatusLabel(tape: Tape, progress: ProgressEntry | undefined): string {
  if (progress?.phase === 'downloading') return `Downloading ${progress.percent.toFixed(0)}%`
  if (progress?.phase === 'probing') return 'Probing'
  return TAPE_STATE_LABEL[tape.state]
}
