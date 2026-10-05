import type { Tape, TapeState } from '@shared/domain'

/** A change of a tape's state, with whatever else changes alongside it. The pause
 * and failure times are not part of it: {@link moveTape} owns them. */
export type TapeMove = Omit<Partial<Tape>, 'pausedAtUtc' | 'failedAtUtc'> & { state: TapeState }

/**
 * Move a tape to a new state. The pause and failure times each belong to their own
 * state: entering it sets the time to `nowUtc`, staying in it keeps the time, and
 * leaving it clears the time (content-lifecycle conventions).
 */
export function moveTape(tape: Tape, move: TapeMove, nowUtc: string): Tape {
  const next = { ...tape, ...move }
  return {
    ...next,
    pausedAtUtc: stateTime(tape, next.state, 'paused', tape.pausedAtUtc, nowUtc),
    failedAtUtc: stateTime(tape, next.state, 'failed', tape.failedAtUtc, nowUtc),
  }
}

function stateTime(tape: Tape, to: TapeState, owner: TapeState, kept: string | null, nowUtc: string): string | null {
  if (to !== owner) return null
  return tape.state === owner ? kept : nowUtc
}
