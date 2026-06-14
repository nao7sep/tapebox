import type { Tape } from '@shared/domain'
import { useTapesStore } from '@renderer/store/tapes'
import { useBoxesStore } from '@renderer/store/boxes'
import { useSelectionStore } from '@renderer/store/selection'
import { useVisibleTapes } from '@renderer/lib/tapeOrder'
import { selectTape } from '@renderer/lib/selectTape'
import { UNBOXED_LABEL } from '@shared/box-names'
import { TapeRow } from './TapeRow'

/**
 * Read-only results for an archive search: matching tapes across all boxes,
 * ordered exactly like the box list reads (Unboxed first, then boxes in their
 * order) and grouped under a header band per box. The header — a flush, borderless
 * strip that sticks to the top while scrolling — does the job the old per-row
 * "in <box>" caption did, but as a real separator instead of a repeated label.
 * Not sortable: the order belongs to the boxes, not to this view.
 */
export function SearchResults() {
  const tapes = useVisibleTapes()
  const boxes = useBoxesStore((s) => s.boxes)
  const progress = useTapesStore((s) => s.progress)
  const selectedId = useSelectionStore((s) => s.selectedId)

  if (tapes.length === 0) {
    return <div className="p-6 text-sm text-zinc-300">No archived tapes match.</div>
  }

  const boxName = (boxId: string | null) =>
    boxId === null ? UNBOXED_LABEL : boxes.find((g) => g.id === boxId)?.name ?? UNBOXED_LABEL

  // The list already arrives ordered by box, so equal-box rows are contiguous —
  // group them in one pass, starting a new group whenever the box changes.
  const groups: { boxId: string | null; tapes: Tape[] }[] = []
  for (const tape of tapes) {
    const last = groups[groups.length - 1]
    if (last && last.boxId === tape.boxId) last.tapes.push(tape)
    else groups.push({ boxId: tape.boxId, tapes: [tape] })
  }

  // The list's single tab stop (roving tabindex), across the whole flat result
  // set: the selected row, or the first row when the selection isn't shown here.
  const tabbableId = tapes.some((t) => t.id === selectedId) ? selectedId : tapes[0]?.id

  return (
    <div role="listbox" aria-label="Search results" className="pb-3">
      {groups.map((group) => (
        <section
          key={group.boxId ?? '__unboxed__'}
          role="group"
          aria-label={boxName(group.boxId)}
        >
          <div className="sticky top-0 z-10 bg-zinc-800/95 px-3 py-1 text-xs font-medium uppercase tracking-wide text-zinc-300 backdrop-blur-sm">
            {boxName(group.boxId)}
          </div>
          <ul role="presentation" className="space-y-1.5 px-3 py-2">
            {group.tapes.map((tape) => (
              <li key={tape.id} role="presentation">
                <TapeRow
                  tape={tape}
                  progress={progress[tape.id]}
                  selected={tape.id === selectedId}
                  tabbable={tape.id === tabbableId}
                  onSelect={() => selectTape(tape.id)}
                />
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  )
}
