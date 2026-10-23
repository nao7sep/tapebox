import type { Tape } from './domain.ts'

const IN_FLIGHT_STATES: ReadonlySet<Tape['state']> = new Set(['probing', 'ready', 'downloading'])

/**
 * The durable form of a tape. A tape in flight exists only while its job runs; a
 * restart resumes it from the queue, so it is stored as queued, without the
 * attempt's start time. Its probed metadata is kept, as it is real data.
 */
export function durableTape(tape: Tape): Tape {
  if (!IN_FLIGHT_STATES.has(tape.state)) return tape
  return { ...tape, state: 'queued', downloadStartedAtUtc: null }
}

