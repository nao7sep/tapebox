import { useState } from 'react'
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent,
} from '@dnd-kit/core'
import { arrayMove } from '@dnd-kit/sortable'
import { ipcInvoke } from '@renderer/ipc/client'
import { useTapesStore } from '@renderer/store/tapes'
import { useBoxesStore } from '@renderer/store/boxes'
import { useArchiveStore } from '@renderer/store/archive'
import { useLayoutStore, patchLayout } from '@renderer/store/layout'
import { useVisibleTapes } from '@renderer/lib/tapeOrder'
import { BoxList, LOOSE_DROP_ID } from './BoxList'
import { ArchiveTapeList } from './ArchiveTapeList'
import { SearchResults } from './SearchResults'
import { ResizeHandle } from './ResizeHandle'
import { TapeRow } from './TapeRow'

/**
 * The archived view's left-pane layout and drag handling: boxes on top, the
 * selected box's tapes below. One DndContext covers both lists so a tape can be
 * dragged from the lower list onto a box in the upper one. Drags update the
 * stores optimistically, then persist via archive:placeTapes / reorderBoxes
 * (the IPC re-emits the authoritative state).
 */
export function ArchiveOrganizer() {
  const boxes = useBoxesStore((s) => s.boxes)
  const selectedBoxId = useArchiveStore((s) => s.selectedBoxId)
  const query = useArchiveStore((s) => s.query)
  const setQuery = useArchiveStore((s) => s.setQuery)
  const boxesHeight = useLayoutStore((s) => s.layout.archiveBoxesHeight)
  const progress = useTapesStore((s) => s.progress)
  const tapes = useVisibleTapes()
  const searching = query.trim().length > 0

  // What's being dragged, so a DragOverlay can render a copy that follows the
  // cursor unclipped — without it, dragging a tape up over the boxes list pulls
  // it out of its scroll container and it visually vanishes.
  const [activeDrag, setActiveDrag] = useState<{ type: 'tape' | 'box'; id: string } | null>(null)
  const draggedTape = activeDrag?.type === 'tape' ? tapes.find((t) => t.id === activeDrag.id) : undefined
  const draggedBox = activeDrag?.type === 'box' ? boxes.find((b) => b.id === activeDrag.id) : undefined

  // A small movement threshold so plain clicks (select box/tape, rename, delete)
  // don't start a drag.
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }))

  function onDragStart({ active }: DragStartEvent) {
    const type = active.data.current?.type
    if (type === 'tape' || type === 'box') setActiveDrag({ type, id: String(active.id) })
  }

  function onDragEnd({ active, over }: DragEndEvent) {
    if (!over) return
    const activeType = active.data.current?.type
    const overType = over.data.current?.type
    const activeId = String(active.id)
    const overId = String(over.id)

    if (activeType === 'box') {
      if (activeId === overId) return
      const ids = [...boxes].sort((a, b) => a.order - b.order).map((g) => g.id)
      const from = ids.indexOf(activeId)
      const to = ids.indexOf(overId)
      if (from < 0 || to < 0) return
      const next = arrayMove(ids, from, to)
      const orderById = new Map(next.map((id, i) => [id, i]))
      useBoxesStore.getState().setBoxes(boxes.map((g) => ({ ...g, order: orderById.get(g.id) ?? g.order })))
      void ipcInvoke('boxes:reorder', { orderedIds: next })
      return
    }

    if (activeType === 'tape') {
      // Dropped onto a box header (or Loose) → file it there.
      if (overType === 'box' || overId === LOOSE_DROP_ID) {
        const boxId = overId === LOOSE_DROP_ID ? null : overId
        if (boxId === selectedBoxId) return
        void ipcInvoke('boxes:place', { tapeIds: [activeId], boxId, beforeTapeId: null })
        return
      }
      // Dropped onto another tape → reorder within the current box.
      if (overType === 'tape' && activeId !== overId) {
        const from = tapes.findIndex((t) => t.id === activeId)
        const to = tapes.findIndex((t) => t.id === overId)
        if (from < 0 || to < 0) return
        const reordered = arrayMove(tapes, from, to)
        useTapesStore
          .getState()
          .upsertMany(reordered.map((t, i) => ({ ...t, boxId: selectedBoxId, boxOrder: i })))
        const pos = reordered.findIndex((t) => t.id === activeId)
        const beforeTapeId = reordered[pos + 1]?.id ?? null
        void ipcInvoke('boxes:place', { tapeIds: [activeId], boxId: selectedBoxId, beforeTapeId })
      }
    }
  }

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCenter}
      onDragStart={onDragStart}
      onDragEnd={(e) => { onDragEnd(e); setActiveDrag(null) }}
      onDragCancel={() => setActiveDrag(null)}
    >
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
            onResize={(h) => patchLayout({ archiveBoxesHeight: h }, false)}
            onCommit={(h) => patchLayout({ archiveBoxesHeight: h }, true)}
          />
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto">
          {searching ? <SearchResults /> : <ArchiveTapeList />}
        </div>
      </div>
      <DragOverlay>
        {draggedTape ? (
          <TapeRow tape={draggedTape} progress={progress[draggedTape.id]} selected={false} onSelect={() => {}} />
        ) : draggedBox ? (
          <div className="rounded bg-zinc-800 px-2 py-1.5 text-sm text-zinc-100 shadow-lg">
            {draggedBox.name}
          </div>
        ) : null}
      </DragOverlay>
    </DndContext>
  )
}
