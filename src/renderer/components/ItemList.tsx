import type { Item } from '@shared/domain'
import { useItemsStore } from '@renderer/store/items'
import { useSelectionStore } from '@renderer/store/selection'
import { useFilterStore, type Filter } from '@renderer/store/filter'
import { ItemRow } from './ItemRow'

/**
 * One continuous list per tab.
 *
 * Inbox (everything not archived) is sorted by bucket, each bucket newest-first:
 *   1. Failed       (failedAtUtc)
 *   2. Downloading  (downloadStartedAtUtc)
 *   3. Pending      (addedAtUtc) — queued, probing, ready, paused
 *   4. Downloaded   (downloadedAtUtc)
 *
 * Archived is sorted by downloadedAtUtc so archive/unarchive cycles don't
 * reshuffle the list.
 */
export function ItemList() {
  const items = useItemsStore((s) => s.items)
  const progress = useItemsStore((s) => s.progress)
  const selectedId = useSelectionStore((s) => s.selectedId)
  const select = useSelectionStore((s) => s.select)
  const filter = useFilterStore((s) => s.filter)

  const visible = sortFor(filter, items.filter((i) => matchesFilter(i, filter)))

  if (visible.length === 0) {
    return (
      <div className="p-6 text-sm text-zinc-400">
        {emptyMessageFor(filter)}
      </div>
    )
  }

  return (
    <ul className="space-y-1.5 p-3">
      {visible.map((item) => (
        <li key={item.id}>
          <ItemRow
            item={item}
            progress={progress[item.id]}
            selected={item.id === selectedId}
            onSelect={() => select(item.id)}
          />
        </li>
      ))}
    </ul>
  )
}

function matchesFilter(item: Item, filter: Filter): boolean {
  return filter === 'archived' ? !!item.archivedAtUtc : !item.archivedAtUtc
}

type Bucket = 'failed' | 'downloading' | 'pending' | 'downloaded'

function bucketOf(item: Item): Bucket {
  if (item.state === 'failed') return 'failed'
  if (item.state === 'downloading') return 'downloading'
  if (item.state === 'downloaded') return 'downloaded'
  return 'pending' // queued, probing, ready, paused
}

const BUCKET_RANK: Record<Bucket, number> = {
  failed: 0,
  downloading: 1,
  pending: 2,
  downloaded: 3,
}

/** Newest-first key per bucket; falls back to addedAtUtc if the marker is missing. */
function sortKey(item: Item, bucket: Bucket): string {
  switch (bucket) {
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

function emptyMessageFor(filter: Filter): string {
  return filter === 'archived' ? 'No archived tapes yet.' : 'No tapes here. Paste a URL to add one.'
}
