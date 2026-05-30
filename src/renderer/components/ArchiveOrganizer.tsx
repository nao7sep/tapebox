import {
  DndContext,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core'
import { arrayMove } from '@dnd-kit/sortable'
import { ipcInvoke } from '@renderer/ipc/client'
import { useItemsStore } from '@renderer/store/items'
import { useGroupsStore } from '@renderer/store/groups'
import { useArchiveStore } from '@renderer/store/archive'
import { useVisibleItems } from '@renderer/lib/itemOrder'
import { BoxList, UNGROUPED_DROP_ID } from './BoxList'
import { ArchiveTapeList } from './ArchiveTapeList'

/**
 * The archived view's left-pane layout and drag handling: boxes on top, the
 * selected box's tapes below. One DndContext covers both lists so a tape can be
 * dragged from the lower list onto a box in the upper one. Drags update the
 * stores optimistically, then persist via archive:placeItems / reorderGroups
 * (the IPC re-emits the authoritative state).
 */
export function ArchiveOrganizer() {
  const groups = useGroupsStore((s) => s.groups)
  const selectedGroupId = useArchiveStore((s) => s.selectedGroupId)
  const tapes = useVisibleItems()

  // A small movement threshold so plain clicks (select box/tape, rename, delete)
  // don't start a drag.
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }))

  function onDragEnd({ active, over }: DragEndEvent) {
    if (!over) return
    const activeType = active.data.current?.type
    const overType = over.data.current?.type
    const activeId = String(active.id)
    const overId = String(over.id)

    if (activeType === 'box') {
      if (activeId === overId) return
      const ids = [...groups].sort((a, b) => a.order - b.order).map((g) => g.id)
      const from = ids.indexOf(activeId)
      const to = ids.indexOf(overId)
      if (from < 0 || to < 0) return
      const next = arrayMove(ids, from, to)
      const orderById = new Map(next.map((id, i) => [id, i]))
      useGroupsStore.getState().setGroups(groups.map((g) => ({ ...g, order: orderById.get(g.id) ?? g.order })))
      void ipcInvoke('archive:reorderGroups', { orderedIds: next })
      return
    }

    if (activeType === 'tape') {
      // Dropped onto a box header (or Ungrouped) → file it there.
      if (overType === 'box' || overId === UNGROUPED_DROP_ID) {
        const groupId = overId === UNGROUPED_DROP_ID ? null : overId
        if (groupId === selectedGroupId) return
        void ipcInvoke('archive:placeItems', { itemIds: [activeId], groupId, beforeItemId: null })
        return
      }
      // Dropped onto another tape → reorder within the current box.
      if (overType === 'tape' && activeId !== overId) {
        const from = tapes.findIndex((t) => t.id === activeId)
        const to = tapes.findIndex((t) => t.id === overId)
        if (from < 0 || to < 0) return
        const reordered = arrayMove(tapes, from, to)
        useItemsStore
          .getState()
          .upsertMany(reordered.map((t, i) => ({ ...t, groupId: selectedGroupId, archiveOrder: i })))
        const pos = reordered.findIndex((t) => t.id === activeId)
        const beforeItemId = reordered[pos + 1]?.id ?? null
        void ipcInvoke('archive:placeItems', { itemIds: [activeId], groupId: selectedGroupId, beforeItemId })
      }
    }
  }

  return (
    <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
      <div className="flex min-h-0 flex-1 flex-col">
        <div className="flex max-h-[45%] min-h-0 flex-col border-b border-zinc-800">
          <BoxList />
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto">
          <ArchiveTapeList />
        </div>
      </div>
    </DndContext>
  )
}
