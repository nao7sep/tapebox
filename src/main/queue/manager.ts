import * as session from '@main/store/session'
import { getSettings } from '@main/store/config'
import { emit } from '@main/ipc/events'
import { log } from '@main/io/logger'
import { nowUtcIso } from '@shared/utc'
import { Job } from './job'

/**
 * Download queue.
 *
 * Stateless aside from a Map of active Jobs by itemId. The "what to run next"
 * truth lives in session.items: any item in state 'queued' that isn't already
 * active is a candidate. Concurrency is bounded by settings.maxConcurrentDownloads.
 *
 * tick() is the single scheduler entry point — called when items are added,
 * resumed, or when an active job finishes.
 *
 * cancel() returns a Promise that resolves once the underlying yt-dlp
 * process has exited and the Job's finally blocks have run. Callers that
 * need to touch the item's files (library:remove, library:renameToSlug)
 * must await this before doing so — otherwise yt-dlp keeps writing into
 * paths that have just been unlinked.
 */

const active = new Map<string, Job>()

export function tick(): void {
  const max = getSettings().maxConcurrentDownloads
  if (active.size >= max) return

  const candidates = session
    .getItems()
    .filter((i) => i.state === 'queued' && !active.has(i.id))

  for (const item of candidates) {
    if (active.size >= max) break
    const job = new Job(item)
    active.set(item.id, job)
    log.info(`job start: ${item.id}`, { url: item.sourceUrl })
    void job
      .run()
      .finally(() => {
        active.delete(item.id)
        tick()
      })
  }
}

/**
 * Resume every paused item: transition to 'queued' and let tick() schedule them
 * under the concurrency cap. Called when the user switches autostart on — items
 * that were parked because autostart was off should start flowing immediately.
 * Playlist dead-ends rest in 'playlist', not 'paused', so they're untouched here.
 */
export function resumePaused(): void {
  for (const item of session.getItems()) {
    if (item.state !== 'paused') continue
    const next = { ...item, state: 'queued' as const, lastError: null }
    session.upsertItem(next)
    emit('items:updated', next)
  }
  tick()
}

/**
 * Awaitable cancel. Resolves only after the Job's run() has settled — i.e.,
 * yt-dlp has exited and disk state is no longer being mutated by this job.
 */
export async function cancel(itemId: string): Promise<void> {
  const job = active.get(itemId)
  if (!job) return
  await job.cancel()
}

export function isActive(itemId: string): boolean {
  return active.has(itemId)
}

/**
 * Called once at startup. Any item that was 'probing' or 'downloading' when
 * we shut down has been orphaned — its process is gone. Reset to 'queued'
 * (or 'paused' if autostart is off) so the queue picks it back up.
 */
export function start(): void {
  const autostart = getSettings().autoStartDownloads
  const orphaned = session
    .getItems()
    .filter((i) => i.state === 'probing' || i.state === 'downloading')

  const now = nowUtcIso()
  for (const item of orphaned) {
    const next = autostart
      ? { ...item, state: 'queued' as const }
      : { ...item, state: 'paused' as const, pausedAtUtc: now }
    session.upsertItem(next)
    emit('items:updated', next)
  }

  tick()
}
