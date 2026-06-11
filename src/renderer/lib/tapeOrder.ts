import type { Box, Tape } from '@shared/domain'
import { useTapesStore } from '@renderer/store/tapes'
import { useBoxesStore } from '@renderer/store/boxes'
import { useFilterStore, type Filter } from '@renderer/store/filter'
import { useArchiveStore } from '@renderer/store/archive'

/**
 * The on-screen order of the tape list — the single source of truth shared by
 * the list view, drag-reordering, keyboard navigation, and removal, so they all
 * agree on which tape is next and previous.
 *
 * Order is explicit and manual: every tape carries an `order` (lower = nearer the
 * top) within its current list — the inbox, a box, or Unboxed. New tapes are
 * inserted at the top and the user can drag any tape anywhere. A tape's state
 * (downloading, failed, a page-of-videos dead-end) no longer moves it: that
 * information lives in the status bar and on the row itself, so a failed download
 * stays exactly where it was instead of jumping the list.
 *
 * Order ties — a fresh library where nothing's been hand-ordered yet, so every
 * tape sits at the default 0 — break by recency, newest first. That gives the
 * new-on-top feel before anyone has dragged a thing.
 */

/** Newest-first key: when the tape landed, falling back to when it was added. */
function recencyKey(tape: Tape): string {
  return tape.downloadedAtUtc ?? tape.addedAtUtc
}

/** Manual order ascending (top first), ties broken newest-first. */
function byOrder(a: Tape, b: Tape): number {
  return a.order - b.order || recencyKey(b).localeCompare(recencyKey(a))
}

/**
 * Pure: the on-screen tape order. The inbox is every non-archived tape in manual
 * order. The archived view shows one box at a time (selectedBoxId, null = Unboxed)
 * in manual order — unless a search query is active, in which case it spans ALL
 * boxes, ordered the same way the box list reads (Unboxed first, then boxes by their
 * order) and within each box by that box's manual order. Search is read-only (not
 * drag-reorderable), but it's no longer recency-shuffled: a tape from box A always
 * precedes one from box B when A precedes B.
 */
export function visibleTapes(
  tapes: Tape[],
  filter: Filter,
  selectedBoxId: string | null = null,
  query = '',
  boxes: Box[] = [],
): Tape[] {
  if (filter !== 'archived') {
    return tapes.filter((t) => !t.archivedAtUtc).sort(byOrder)
  }

  const archived = tapes.filter((t) => !!t.archivedAtUtc)
  const q = query.trim().toLowerCase()
  if (q) {
    // Unboxed (no box) leads, mirroring the box list where Unboxed sits on top; then
    // boxes in their own order. Unknown box ids (shouldn't happen) sort last.
    const boxRankById = new Map(boxes.map((b) => [b.id, b.order]))
    const boxRank = (boxId: string | null) =>
      boxId === null ? -Infinity : boxRankById.get(boxId) ?? Infinity
    return archived
      .filter((t) => (t.title ?? t.sourceUrl).toLowerCase().includes(q))
      .sort((a, b) => boxRank(a.boxId) - boxRank(b.boxId) || byOrder(a, b))
  }
  return archived.filter((t) => t.boxId === selectedBoxId).sort(byOrder)
}

/** Reactive: the on-screen tape order for the current filter, box, and search. */
export function useVisibleTapes(): Tape[] {
  const tapes = useTapesStore((s) => s.tapes)
  const filter = useFilterStore((s) => s.filter)
  const selectedBoxId = useArchiveStore((s) => s.selectedBoxId)
  const query = useArchiveStore((s) => s.query)
  const boxes = useBoxesStore((s) => s.boxes)
  return visibleTapes(tapes, filter, selectedBoxId, query, boxes)
}
