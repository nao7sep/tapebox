import * as session from '@main/store/session'
import { getSettings } from '@main/store/config'
import { emit } from '@main/ipc/events'
import { log } from '@main/io/logger'
import { stripUrlCredentials } from '@shared/url'
import { isLibraryMoving, tryClaimLibraryWrite } from '@main/library-writes'
import { Job } from './job'
import { selectTapesToStart } from './schedule'

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
let stopped = false

/**
 * Start what the concurrency cap allows. Each job holds a library write claim for
 * its whole run (it finalizes straight into the library folder), so a library move
 * refuses while any runs; during a move nothing starts, and the move's owner ticks
 * again when it ends.
 */
export function tick(): void {
  if (stopped || isLibraryMoving()) return
  const max = getSettings().maxConcurrentDownloads
  const toStart = selectTapesToStart(session.getTapes(), new Set(active.keys()), max)

  for (const tape of toStart) {
    const release = tryClaimLibraryWrite()
    if (!release) return
    const job = new Job(tape)
    active.set(tape.id, job)
    log.info('job start', { tapeId: tape.id, url: stripUrlCredentials(tape.sourceUrl) })
    void job
      .run()
      .finally(() => {
        release()
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
    const next = { ...tape, state: 'queued' as const, failureCode: null, lastError: null }
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

/**
 * Quit-time teardown: start no further jobs, stop every running one (killing its
 * yt-dlp/ffmpeg/Deno process tree) and resolve once each has settled. Stopped
 * tapes keep their queued place and resume on the next launch.
 */
export async function shutdown(): Promise<void> {
  stopped = true
  await Promise.all([...active.values()].map((job) => job.stop()))
}

export function isActive(tapeId: string): boolean {
  return active.has(tapeId)
}

/**
 * Called once at startup. A download that was in flight when the app stopped
 * comes back from the catalog as queued (see session's durableTape), so starting
 * the queue resumes it.
 */
export function start(): void {
  tick()
}
