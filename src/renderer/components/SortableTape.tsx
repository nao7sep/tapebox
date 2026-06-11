import type { ReactNode } from 'react'
import { useSortable } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'

/**
 * One drag-sortable list item, shared by the inbox and the archive's box list.
 * The whole row is the drag handle (the parent DndContext's PointerSensor has a
 * small movement threshold, so a plain click still selects). While dragging, the
 * original is hidden rather than dimmed because the parent renders a DragOverlay
 * copy that follows the cursor — without it, a row dragged past its scroll
 * container's edge would clip and vanish; it only holds its place here.
 */
export function SortableTape({ id, children }: { id: string; children: ReactNode }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id,
    data: { type: 'tape' },
  })
  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0 : 1,
  }
  return (
    <li ref={setNodeRef} style={style} {...attributes} {...listeners}>
      {children}
    </li>
  )
}
