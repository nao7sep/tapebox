import type { Item } from '@shared/domain'
import { useItemsStore } from '@renderer/store/items'
import { useFilterStore, type Filter } from '@renderer/store/filter'
import { useArchiveStore } from '@renderer/store/archive'

/**
 * The on-screen order of the item list — the single source of truth shared by
 * the list view, keyboard navigation, and removal, so they all agree on which
 * item is "next" and "previous".
 *
 * Shelf (everything not archived) is sorted by bucket, each bucket newest-first:
 *   1. Failed       (failedAtUtc)
 *   2. Downloading  (downloadStartedAtUtc)
 *   3. Pending      (addedAtUtc) — queued, probing, ready, paused
 *   4. Downloaded   (downloadedAtUtc)
 *
 * Archived is sorted by downloadedAtUtc so archive/unarchive cycles don't
 * reshuffle the list.
 */

function matchesFilter(item: Item, filter: Filter): boolean {
  return filter === 'archived' ? !!item.archivedAtUtc : !item.archivedAtUtc
}

type Bucket = 'playlist' | 'failed' | 'downloading' | 'pending' | 'downloaded'

function bucketOf(item: Item): Bucket {
  if (item.state === 'playlist') return 'playlist'
  if (item.state === 'failed') return 'failed'
  if (item.state === 'downloading') return 'downloading'
  if (item.state === 'downloaded') return 'downloaded'
  return 'pending' // queued, probing, ready, paused
}

// Playlist dead-ends and failures sort to the top — both want the user's attention.
const BUCKET_RANK: Record<Bucket, number> = {
  playlist: 0,
  failed: 1,
  downloading: 2,
  pending: 3,
  downloaded: 4,
}

/** Newest-first key per bucket; falls back to addedAtUtc if the marker is missing. */
function sortKey(item: Item, bucket: Bucket): string {
  switch (bucket) {
    case 'playlist':    return item.probedAtUtc ?? item.addedAtUtc
    case 'failed':      return item.failedAtUtc ?? item.addedAtUtc
    case 'downloading': return item.downloadStartedAtUtc ?? item.addedAtUtc
    case 'pending':     return item.addedAtUtc
    case 'downloaded':  return item.downloadedAtUtc ?? item.addedAtUtc
  }
}

function sortFor(filter: Filter, items: Item[]): Item[] {
  if (filter === 'archived') {
    return [...items].sort((a, b) =>
      (b.downloadedAtUtc ?? b.addedAtUtc).localeCompare(a.downloadedAtUtc ?? a.addedAtUtc),
    )
  }
  return [...items].sort((a, b) => {
    const ba = bucketOf(a)
    const bb = bucketOf(b)
    if (BUCKET_RANK[ba] !== BUCKET_RANK[bb]) return BUCKET_RANK[ba] - BUCKET_RANK[bb]
    return sortKey(b, ba).localeCompare(sortKey(a, ba))
  })
}

/**
 * Pure: the on-screen item order. The shelf is auto-sorted by bucket/recency.
 * The archived view shows one box at a time (selectedGroupId, null = Ungrouped)
 * in manual order, falling back to recency for tapes not yet hand-ordered —
 * unless a search query is active, in which case it shows matching tapes across
 * ALL boxes by recency (read-only, the order isn't a box order).
 */
export function visibleItems(
  items: Item[],
  filter: Filter,
  selectedGroupId: string | null = null,
  query = '',
): Item[] {
  if (filter !== 'archived') {
    return sortFor(filter, items.filter((i) => matchesFilter(i, filter)))
  }

  const archived = items.filter((i) => !!i.archivedAtUtc)
  const byRecency = (a: Item, b: Item) =>
    (b.downloadedAtUtc ?? b.addedAtUtc).localeCompare(a.downloadedAtUtc ?? a.addedAtUtc)

  const q = query.trim().toLowerCase()
  if (q) {
    return archived
      .filter((i) => (i.title ?? i.sourceUrl).toLowerCase().includes(q))
      .sort(byRecency)
  }
  return archived
    .filter((i) => i.groupId === selectedGroupId)
    .sort((a, b) => a.archiveOrder - b.archiveOrder || byRecency(a, b))
}

/** Reactive: the on-screen item order for the current filter, box, and search. */
export function useVisibleItems(): Item[] {
  const items = useItemsStore((s) => s.items)
  const filter = useFilterStore((s) => s.filter)
  const selectedGroupId = useArchiveStore((s) => s.selectedGroupId)
  const query = useArchiveStore((s) => s.query)
  return visibleItems(items, filter, selectedGroupId, query)
}
