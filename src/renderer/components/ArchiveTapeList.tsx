import { SortableContext, verticalListSortingStrategy } from '@dnd-kit/sortable'
import { useTapesStore } from '@renderer/store/tapes'
import { useSelectionStore } from '@renderer/store/selection'
import { useVisibleTapes } from '@renderer/lib/tapeOrder'
import { selectTape } from '@renderer/lib/selectTape'
import { TapeRow } from './TapeRow'
import { SortableTape } from './SortableTape'

/**
 * The selected box's tapes, in manual order, as a sortable list. Reorder within
 * the box (drag a tape over another) and move between boxes (drag a tape onto a
 * box row) are both handled by the parent DndContext's onDragEnd. Rows reuse the
 * shared TapeRow; the sortable wrapper is shared with the inbox.
 */
export function ArchiveTapeList() {
  const tapes = useVisibleTapes()
  const progress = useTapesStore((s) => s.progress)
  const selectedId = useSelectionStore((s) => s.selectedId)

  if (tapes.length === 0) {
    return <div className="p-6 text-sm text-zinc-300">This box is empty.</div>
  }

  // The list's single tab stop (roving tabindex): the selected row, or the first
  // row when the selection isn't in this box.
  const tabbableId = tapes.some((t) => t.id === selectedId) ? selectedId : tapes[0]?.id

  return (
    <SortableContext items={tapes.map((t) => t.id)} strategy={verticalListSortingStrategy}>
      <ul role="listbox" aria-label="Box tapes" className="space-y-1.5 p-3">
        {tapes.map((tape) => (
          <SortableTape key={tape.id} id={tape.id}>
            <TapeRow
              tape={tape}
              progress={progress[tape.id]}
              selected={tape.id === selectedId}
              tabbable={tape.id === tabbableId}
              onSelect={() => selectTape(tape.id)}
            />
          </SortableTape>
        ))}
      </ul>
    </SortableContext>
  )
}
