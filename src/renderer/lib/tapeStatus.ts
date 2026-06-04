import type { Tape, TapeState } from '@shared/domain'
import type { ProgressEntry } from '@renderer/store/tapes'

/**
 * Title-case label for each tape state, shared by the list rows and the detail
 * header so a tape reads the same wherever it appears (no stray lowercase).
 */
export const TAPE_STATE_LABEL: Record<TapeState, string> = {
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
 * A tape's status as one short phrase: live progress while downloading or
 * probing, otherwise the plain state label.
 */
export function tapeStatusLabel(tape: Tape, progress: ProgressEntry | undefined): string {
  if (progress?.phase === 'downloading') return `Downloading ${progress.percent.toFixed(0)}%`
  if (progress?.phase === 'probing') return 'Probing'
  return TAPE_STATE_LABEL[tape.state]
}
