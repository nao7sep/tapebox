import { nanoid } from 'nanoid'
import { handle } from './handle'
import { emit } from './events'
import * as session from '@main/store/session'
import { getSettings } from '@main/store/config'
import * as queue from '@main/queue/manager'
import { nowUtcIso } from '@shared/utc'
import type { Item } from '@shared/domain'

export function registerDownloadHandlers(): void {
  handle('downloads:add', async ({ url }) => {
    const trimmed = url.trim()
    // URL-based dedup for the single-add path (no id yet — it's unprobed). Any
    // existing item with this URL blocks the add, in any state; a failed one is
    // resumed via Retry, not re-added.
    if (session.getItems().some((i) => i.sourceUrl === trimmed)) {
      throw new Error('This URL has already been added.')
    }
    const item = makeQueuedItem(trimmed)
    session.upsertItem(item)
    emit('items:added', [item])
    queue.tick()
    return [item]
  })

  handle('downloads:addBulk', async ({ urls }) => {
    const items = urls.map(makeQueuedItem)
    for (const item of items) session.upsertItem(item)
    emit('items:added', items)
    queue.tick()
    return items
  })

  handle('downloads:cancel', async ({ itemId }) => {
    await queue.cancel(itemId)
  })

  handle('downloads:retry', async ({ itemId }) => {
    // The job clears any stale .part at the start of every attempt, so retry and
    // resume both just re-queue.
    transition(itemId, { state: 'queued', lastError: null })
    queue.tick()
  })
}

function transition(itemId: string, patch: Partial<Item>): void {
  const item = session.getItem(itemId)
  if (!item) return
  const next = { ...item, ...patch }
  session.upsertItem(next)
  emit('items:updated', next)
}

function makeQueuedItem(url: string): Item {
  const autostart = getSettings().autoStartDownloads
  const now = nowUtcIso()
  return {
    id: nanoid(10),
    sourceUrl: url,
    state: autostart ? 'queued' : 'paused',
    addedAtUtc: now,
    sourceId: null,
    title: null,
    originalTitle: null,
    uploader: null,
    durationSeconds: null,
    chapterCount: null,
    thumbnailUrl: null,
    probedAtUtc: null,
    filename: null,
    sidecarFilename: null,
    downloadStartedAtUtc: null,
    downloadedAtUtc: null,
    slug: null,
    renamedAtUtc: null,
    archivedAtUtc: null,
    groupId: null,
    archiveOrder: 0,
    pausedAtUtc: autostart ? null : now,
    failedAtUtc: null,
    lastError: null,
  }
}
