import type { Tape } from '@shared/domain'

// The pure scheduling decision behind the queue manager, lifted out so the
// concurrency bound is testable without the manager's module-level state, the
// session, or real Jobs.

/**
 * Which queued tapes to start next, bounded by the concurrency cap. A tape is a
 * candidate when it is `queued` and not already running; at most
 * `max - activeIds.size` are returned (the free slots), in list order.
 */
export function selectTapesToStart(
  tapes: readonly Tape[],
  activeIds: ReadonlySet<string>,
  max: number,
): Tape[] {
  const remaining = Math.max(0, max - activeIds.size)
  if (remaining === 0) return []
  return tapes.filter((tape) => tape.state === 'queued' && !activeIds.has(tape.id)).slice(0, remaining)
}
