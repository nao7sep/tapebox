import type { ReactNode } from 'react'
import { SortableContext, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { useTapesStore } from '@renderer/store/tapes'
import { useSelectionStore } from '@renderer/store/selection'
import { useVisibleTapes } from '@renderer/lib/tapeOrder'
import { TapeRow } from './TapeRow'

/**
 * The selected box's tapes, in manual order, as a sortable list. Reorder within
 * the box (drag a tape over another) and move between boxes (drag a tape onto a
 * box row) are both handled by the parent DndContext's onDragEnd. Rows reuse the
 * shared TapeRow; only the sortable wrapper is new.
 */
export function ArchiveTapeList() {
  const tapes = useVisibleTapes()
  const progress = useTapesStore((s) => s.progress)
  const selectedId = useSelectionStore((s) => s.selectedId)
  const select = useSelectionStore((s) => s.select)

  if (tapes.length === 0) {
    return <div className="p-6 text-sm text-zinc-300">This box is empty.</div>
  }

  return (
    <SortableContext items={tapes.map((t) => t.id)} strategy={verticalListSortingStrategy}>
      <ul className="space-y-1.5 p-3">
        {tapes.map((tape) => (
          <SortableTape key={tape.id} id={tape.id}>
            <TapeRow
              tape={tape}
              progress={progress[tape.id]}
              selected={tape.id === selectedId}
              onSelect={() => select(tape.id)}
            />
          </SortableTape>
        ))}
      </ul>
    </SortableContext>
  )
}

function SortableTape({ id, children }: { id: string; children: ReactNode }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id,
    data: { type: 'tape' },
  })
  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.4 : 1,
  }
  return (
    <li ref={setNodeRef} style={style} {...attributes} {...listeners}>
      {children}
    </li>
  )
}
