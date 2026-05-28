import * as session from '@main/store/session'
import { getSettings } from '@main/store/config'
import { emit } from '@main/ipc/events'
import { log } from '@main/io/logger'
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

export function cancel(itemId: string): void {
  active.get(itemId)?.cancel()
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

  for (const item of orphaned) {
    const next = { ...item, state: autostart ? ('queued' as const) : ('paused' as const) }
    session.upsertItem(next)
    emit('items:updated', next)
  }

  tick()
}
