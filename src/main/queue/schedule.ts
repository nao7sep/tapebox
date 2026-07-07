import type { Tape } from '@shared/domain'

// The pure scheduling decisions behind the queue manager, lifted out so the
// concurrency bound and the startup orphan reset are testable without the
// manager's module-level state, the session, or real Jobs.

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

/**
 * The startup reset for tapes interrupted mid-flight. Any tape left `probing` or
 * `downloading` when the app stopped has been orphaned — its process is gone — so
 * it returns to `queued` (when autostart is on) or `paused` (when off, stamping
 * the pause time) for the queue to pick up again. Other states are untouched.
 */
export function planOrphanResets(tapes: readonly Tape[], autostart: boolean, now: string): Tape[] {
  return tapes
    .filter((tape) => tape.state === 'probing' || tape.state === 'downloading')
    .map((tape) =>
      autostart
        ? { ...tape, state: 'queued' as const }
        : { ...tape, state: 'paused' as const, pausedAtUtc: now },
    )
}
