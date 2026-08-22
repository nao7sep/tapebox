import { SortableContext, verticalListSortingStrategy } from '@dnd-kit/sortable'
import { useTapesStore } from '@renderer/store/tapes'
import { useSelectionStore } from '@renderer/store/selection'
import { useVisibleTapes } from '@renderer/lib/tapeOrder'
import { selectTape } from '@renderer/lib/selectTape'
import { useTapeListboxKeyboard } from '@renderer/lib/useTapeListboxKeyboard'
import { TapeRow } from './TapeRow'
import { SortableTape } from './SortableTape'

/**
 * The selected box's tapes, in manual order, as a sortable list. Reorder within
 * the box (drag a tape over another) and move between boxes (drag a tape onto a
 * box row) are both handled by the parent DndContext's onDragEnd. Rows reuse the
 * shared TapeRow; the sortable wrapper is shared with the inbox.
 */
export function ArchiveTapeList({ onReorder }: { onReorder: (activeId: string, offset: -1 | 1) => void }) {
  const tapes = useVisibleTapes()
  const progress = useTapesStore((s) => s.progress)
  const selectedId = useSelectionStore((s) => s.selectedId)
  const kb = useTapeListboxKeyboard<HTMLUListElement>(tapes, selectedId, onReorder)

  if (tapes.length === 0) {
    return <div className="p-6 text-sm text-zinc-300">This box is empty.</div>
  }

  return (
    <SortableContext items={tapes.map((t) => t.id)} strategy={verticalListSortingStrategy}>
      <ul
        ref={kb.ref}
        {...kb.listboxProps}
        role="listbox"
        aria-label="Box tapes"
        className="space-y-1.5 p-3 outline-none"
      >
        {tapes.map((tape) => (
          <SortableTape key={tape.id} id={tape.id}>
            <TapeRow
              tape={tape}
              progress={progress[tape.id]}
              selected={tape.id === selectedId}
              id={kb.optionId(tape.id)}
              onSelect={() => selectTape(tape.id)}
            />
          </SortableTape>
        ))}
      </ul>
    </SortableContext>
  )
}
