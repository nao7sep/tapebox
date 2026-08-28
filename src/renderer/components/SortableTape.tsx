import type { ReactNode } from 'react'
import { useSortable } from '@dnd-kit/react/sortable'
import { TAPE_DRAG_TYPE, TAPE_SORT_GROUP } from '@renderer/lib/dnd'

/**
 * One drag-sortable list item, shared by the inbox and the archive's box list.
 * The whole row is the drag handle (the provider's PointerSensor has a
 * small movement threshold, so a plain click still selects). Current dnd-kit owns
 * the fixed feedback layer and placeholder, so the app does not reproduce source
 * transforms, clipping escape, cursor state, or terminal cleanup.
 */
export function SortableTape({
  id,
  index,
  children,
}: {
  id: string
  index: number
  children: ReactNode
}) {
  // The current hook registers transport without projecting DOM attributes.
  // role="presentation" keeps the inner TapeRow option as a clean listbox child.
  const { ref } = useSortable({
    id,
    index,
    type: TAPE_DRAG_TYPE,
    accept: TAPE_DRAG_TYPE,
    group: TAPE_SORT_GROUP,
    data: { type: 'tape' },
  })
  return (
    <li ref={ref} role="presentation" className="dnd-sortable">
      {children}
    </li>
  )
}
