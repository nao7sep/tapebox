import type { Item } from '@shared/domain'
import { useItemsStore } from '@renderer/store/items'
import { useFilterStore, type Filter } from '@renderer/store/filter'

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

/** Pure: the filtered, sorted items for a given filter. */
export function visibleItems(items: Item[], filter: Filter): Item[] {
  return sortFor(filter, items.filter((i) => matchesFilter(i, filter)))
}

/** Reactive: the on-screen item order for the current filter. */
export function useVisibleItems(): Item[] {
  const items = useItemsStore((s) => s.items)
  const filter = useFilterStore((s) => s.filter)
  return visibleItems(items, filter)
}
