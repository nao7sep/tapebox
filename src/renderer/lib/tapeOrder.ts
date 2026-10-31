import { useMemo } from 'react'
import type { Box, Tape } from '@shared/domain'
import { compareInbox } from '@shared/order'
import { useTapesStore } from '@renderer/store/tapes'
import { useBoxesStore } from '@renderer/store/boxes'
import { useFilterStore, type Filter } from '@renderer/store/filter'
import { useShelfStore } from '@renderer/store/shelf'

/**
 * The on-screen order of the tape list — the single source of truth shared by
 * the list view, drag-reordering, keyboard navigation, and removal, so they all
 * agree on which tape is next and previous.
 *
 * The Inbox has no chosen order: newest added first, tapes added together in
 * their pasted order (@shared/order). On the Shelf, order is explicit and manual:
 * every shelved tape carries an `order` (lower = nearer the top) within its box
 * or Loose tapes, newcomers go on top, and the user can drag any tape anywhere.
 * A tape's state (downloading, failed, a page-of-videos dead-end) never moves it:
 * that information lives in the status bar and on the row itself.
 *
 * Shelf order ties break by recency, newest first.
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
 * Pure: the on-screen tape order. The Inbox is every tape not on the Shelf,
 * newest added first. The Shelf view shows one box at a time (selectedBoxId, null = Loose tapes)
 * in manual order — unless a search query is active, in which case it spans ALL
 * boxes, ordered the same way the box list reads (Loose tapes first, then boxes by their
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
  if (filter !== 'shelf') {
    return tapes.filter((t) => !t.shelved).sort(compareInbox)
  }

  const shelved = tapes.filter((t) => t.shelved)
  const q = query.trim().toLowerCase()
  if (q) {
    // Loose tapes (no box) leads, mirroring the box list where Loose tapes sits on top; then
    // boxes in their own order. Unknown box ids (shouldn't happen) sort last.
    const boxRankById = new Map(boxes.map((b) => [b.id, b.order]))
    const boxRank = (boxId: string | null) =>
      boxId === null ? -Infinity : boxRankById.get(boxId) ?? Infinity
    return shelved
      .filter((t) => (t.title ?? t.sourceUrl).toLowerCase().includes(q))
      .sort((a, b) => boxRank(a.boxId) - boxRank(b.boxId) || byOrder(a, b))
  }
  return shelved.filter((t) => t.boxId === selectedBoxId).sort(byOrder)
}

/** Reactive: the on-screen tape order for the current filter, box, and search. */
export function useVisibleTapes(): Tape[] {
  const tapes = useTapesStore((s) => s.tapes)
  const filter = useFilterStore((s) => s.filter)
  const selectedBoxId = useShelfStore((s) => s.selectedBoxId)
  const query = useShelfStore((s) => s.query)
  const boxes = useBoxesStore((s) => s.boxes)
  return useMemo(() => visibleTapes(tapes, filter, selectedBoxId, query, boxes), [tapes, filter, selectedBoxId, query, boxes])
}
