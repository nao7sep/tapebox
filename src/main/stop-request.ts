import type { RunStop } from '@shared/records'

/** Why TapeBox aborts work it started: the user cancelled it, or TapeBox is quitting. */
export type StopCause = Extract<RunStop, 'cancel' | 'quit'>

/**
 * The abort reason of every controller whose work runs yt-dlp or ffmpeg, so a run
 * the abort ended records which it was (io/spawn.ts collectOutput) and the
 * Records window reads a cancel apart from a failure. It is still an AbortError.
 */
export class StopRequest extends DOMException {
  constructor(readonly by: StopCause) {
    super(by === 'cancel' ? 'Cancelled' : 'TapeBox is quitting', 'AbortError')
  }
}
