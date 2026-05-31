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
import { useSettingsStore, patchSettings } from '@renderer/store/settings'
import { useVisibleItems } from '@renderer/lib/itemOrder'
import { BoxList, UNGROUPED_DROP_ID } from './BoxList'
import { ArchiveTapeList } from './ArchiveTapeList'
import { SearchResults } from './SearchResults'
import { ResizeHandle } from './ResizeHandle'

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
  const query = useArchiveStore((s) => s.query)
  const setQuery = useArchiveStore((s) => s.setQuery)
  const boxesHeight = useSettingsStore((s) => s.settings?.archiveBoxesHeight ?? 240)
  const tapes = useVisibleItems()
  const searching = query.trim().length > 0

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
        <div className="shrink-0 px-3 py-2">
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search archived…"
            spellCheck={false}
            className="w-full rounded border border-zinc-700 bg-zinc-900 px-2.5 py-1.5 text-sm placeholder-zinc-500 focus:border-zinc-600 focus:outline-hidden"
          />
        </div>
        <div className="relative flex shrink-0 flex-col border-b border-zinc-700" style={{ height: boxesHeight }}>
          <BoxList />
          <ResizeHandle
            edge="bottom"
            size={boxesHeight}
            min={120}
            max={800}
            onResize={(h) => patchSettings({ archiveBoxesHeight: h }, false)}
            onCommit={(h) => patchSettings({ archiveBoxesHeight: h }, true)}
          />
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto">
          {searching ? <SearchResults /> : <ArchiveTapeList />}
        </div>
      </div>
    </DndContext>
  )
}
