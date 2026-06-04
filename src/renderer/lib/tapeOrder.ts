import type { Tape } from '@shared/domain'
import { useTapesStore } from '@renderer/store/tapes'
import { useFilterStore, type Filter } from '@renderer/store/filter'
import { useArchiveStore } from '@renderer/store/archive'

/**
 * The on-screen order of the tape list — the single source of truth shared by
 * the list view, keyboard navigation, and removal, so they all agree on which
 * tape is "next" and "previous".
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

function matchesFilter(tape: Tape, filter: Filter): boolean {
  return filter === 'archived' ? !!tape.archivedAtUtc : !tape.archivedAtUtc
}

type Bucket = 'listing' | 'failed' | 'downloading' | 'pending' | 'downloaded'

function bucketOf(tape: Tape): Bucket {
  if (tape.state === 'listing') return 'listing'
  if (tape.state === 'failed') return 'failed'
  if (tape.state === 'downloading') return 'downloading'
  if (tape.state === 'downloaded') return 'downloaded'
  return 'pending' // queued, probing, ready, paused
}

// Listing dead-ends and failures sort to the top — both want the user's attention.
const BUCKET_RANK: Record<Bucket, number> = {
  listing: 0,
  failed: 1,
  downloading: 2,
  pending: 3,
  downloaded: 4,
}

/** Newest-first key per bucket; falls back to addedAtUtc if the marker is missing. */
function sortKey(tape: Tape, bucket: Bucket): string {
  switch (bucket) {
    case 'listing':        return tape.probedAtUtc ?? tape.addedAtUtc
    case 'failed':      return tape.failedAtUtc ?? tape.addedAtUtc
    case 'downloading': return tape.downloadStartedAtUtc ?? tape.addedAtUtc
    case 'pending':     return tape.addedAtUtc
    case 'downloaded':  return tape.downloadedAtUtc ?? tape.addedAtUtc
  }
}

function sortFor(filter: Filter, tapes: Tape[]): Tape[] {
  if (filter === 'archived') {
    return [...tapes].sort((a, b) =>
      (b.downloadedAtUtc ?? b.addedAtUtc).localeCompare(a.downloadedAtUtc ?? a.addedAtUtc),
    )
  }
  return [...tapes].sort((a, b) => {
    const ba = bucketOf(a)
    const bb = bucketOf(b)
    if (BUCKET_RANK[ba] !== BUCKET_RANK[bb]) return BUCKET_RANK[ba] - BUCKET_RANK[bb]
    return sortKey(b, ba).localeCompare(sortKey(a, ba))
  })
}

/**
 * Pure: the on-screen tape order. The inbox is auto-sorted by bucket/recency.
 * The archived view shows one box at a time (selectedBoxId, null = Loose)
 * in manual order, falling back to recency for tapes not yet hand-ordered —
 * unless a search query is active, in which case it shows matching tapes across
 * ALL boxes by recency (read-only, the order isn't a box order).
 */
export function visibleTapes(
  tapes: Tape[],
  filter: Filter,
  selectedBoxId: string | null = null,
  query = '',
): Tape[] {
  if (filter !== 'archived') {
    return sortFor(filter, tapes.filter((i) => matchesFilter(i, filter)))
  }

  const archived = tapes.filter((i) => !!i.archivedAtUtc)
  const byRecency = (a: Tape, b: Tape) =>
    (b.downloadedAtUtc ?? b.addedAtUtc).localeCompare(a.downloadedAtUtc ?? a.addedAtUtc)

  const q = query.trim().toLowerCase()
  if (q) {
    return archived
      .filter((i) => (i.title ?? i.sourceUrl).toLowerCase().includes(q))
      .sort(byRecency)
  }
  return archived
    .filter((i) => i.boxId === selectedBoxId)
    .sort((a, b) => a.boxOrder - b.boxOrder || byRecency(a, b))
}

/** Reactive: the on-screen tape order for the current filter, box, and search. */
export function useVisibleTapes(): Tape[] {
  const tapes = useTapesStore((s) => s.tapes)
  const filter = useFilterStore((s) => s.filter)
  const selectedBoxId = useArchiveStore((s) => s.selectedBoxId)
  const query = useArchiveStore((s) => s.query)
  return visibleTapes(tapes, filter, selectedBoxId, query)
}
