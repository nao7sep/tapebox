import * as session from '@main/store/session'
import { getSettings } from '@main/store/config'
import { emit } from '@main/ipc/events'
import { log } from '@main/io/logger'
import { nowUtcIso } from '@shared/utc'
import { stripUrlCredentials } from '@shared/url'
import { Job } from './job'

/**
 * Download queue.
 *
 * Stateless aside from a Map of active Jobs by tapeId. The "what to run next"
 * truth lives in session.tapes: any tape in state 'queued' that isn't already
 * active is a candidate. Concurrency is bounded by settings.maxConcurrentDownloads.
 *
 * tick() is the single scheduler entry point — called when tapes are added,
 * resumed, or when an active job finishes.
 *
 * cancel() returns a Promise that resolves once the underlying yt-dlp
 * process has exited and the Job's finally blocks have run. Callers that
 * need to touch the tape's files (library:remove, library:rename)
 * must await this before doing so — otherwise yt-dlp keeps writing into
 * paths that have just been unlinked.
 */

const active = new Map<string, Job>()

export function tick(): void {
  const max = getSettings().maxConcurrentDownloads
  if (active.size >= max) return

  const candidates = session
    .getTapes()
    .filter((i) => i.state === 'queued' && !active.has(i.id))

  for (const tape of candidates) {
    if (active.size >= max) break
    const job = new Job(tape)
    active.set(tape.id, job)
    log.info('job start', { tapeId: tape.id, url: stripUrlCredentials(tape.sourceUrl) })
    void job
      .run()
      .finally(() => {
        active.delete(tape.id)
        tick()
      })
  }
}

/**
 * Resume every paused tape: transition to 'queued' and let tick() schedule them
 * under the concurrency cap. Called when the user switches autostart on — tapes
 * that were parked because autostart was off should start flowing immediately.
 * Listing dead-ends rest in 'listing', not 'paused', so they're untouched here.
 */
export function resumePaused(): void {
  for (const tape of session.getTapes()) {
    if (tape.state !== 'paused') continue
    const next = { ...tape, state: 'queued' as const, lastError: null }
    session.upsertTape(next)
    emit('tapes:updated', next)
  }
  tick()
}

/**
 * Awaitable cancel. Resolves only after the Job's run() has settled — i.e.,
 * yt-dlp has exited and disk state is no longer being mutated by this job.
 */
export async function cancel(tapeId: string): Promise<void> {
  const job = active.get(tapeId)
  if (!job) return
  await job.cancel()
}

export function isActive(tapeId: string): boolean {
  return active.has(tapeId)
}

/**
 * Called once at startup. Any tape that was 'probing' or 'downloading' when
 * we shut down has been orphaned — its process is gone. Reset to 'queued'
 * (or 'paused' if autostart is off) so the queue picks it back up.
 */
export function start(): void {
  const autostart = getSettings().autoStartDownloads
  const orphaned = session
    .getTapes()
    .filter((i) => i.state === 'probing' || i.state === 'downloading')

  const now = nowUtcIso()
  for (const tape of orphaned) {
    const next = autostart
      ? { ...tape, state: 'queued' as const }
      : { ...tape, state: 'paused' as const, pausedAtUtc: now }
    session.upsertTape(next)
    emit('tapes:updated', next)
  }

  tick()
}
