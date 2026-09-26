import { DOWNLOAD_STALL_AFTER_MS, type Tape, type TapeState } from '@shared/domain'
import type { ProgressEntry } from '@renderer/store/tapes'
import type { MessageKey } from '@shared/i18n/catalogues'
import { joinMessages, message, type Message } from '@shared/i18n/translate'

/**
 * Title-case label for each tape state. Module-private: callers go through
 * tapeStatusLabel() below (which layers live progress on top), so a tape reads
 * the same wherever it appears (no stray lowercase).
 */
const TAPE_STATE_LABEL: Record<TapeState, MessageKey> = {
  queued: 'tapeState.queued',
  probing: 'tapeState.probing',
  ready: 'tapeState.ready',
  downloading: 'tapeState.downloading',
  downloaded: 'tapeState.downloaded',
  failed: 'tapeState.failed',
  paused: 'tapeState.paused',
  listing: 'tapeState.listing',
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
 * probing, otherwise the plain state label. A download main reports as stalled
 * says so, so the user can decide whether to cancel it.
 */
export function tapeStatusLabel(tape: Tape, progress: ProgressEntry | undefined, stalled = false): Message {
  const base = progress?.phase === 'downloading'
    ? message('tapeState.downloadingPercent', { percent: Math.round(progress.percent) })
    : message(progress?.phase === 'probing' ? 'tapeState.probing' : TAPE_STATE_LABEL[tape.state])
  return stalled && isProcessing(tape.state)
    ? joinMessages(base, message('tapeState.stalled', { count: DOWNLOAD_STALL_AFTER_MS / 60_000 }))
    : base
}
