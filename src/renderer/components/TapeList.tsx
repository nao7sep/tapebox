import { useEffect, useRef, useState } from 'react'
import {
  DndContext,
  DragOverlay,
  closestCenter,
  type DragEndEvent,
  type DragStartEvent,
} from '@dnd-kit/core'
import { SortableContext, arrayMove, verticalListSortingStrategy } from '@dnd-kit/sortable'
import { ipcInvoke, ipcOn } from '@renderer/ipc/client'
import { useTapesStore } from '@renderer/store/tapes'
import { useSelectionStore } from '@renderer/store/selection'
import { useFilterStore, type Filter } from '@renderer/store/filter'
import { useVisibleTapes } from '@renderer/lib/tapeOrder'
import { useTapeDragSensors } from '@renderer/lib/dnd'
import { TapeRow } from './TapeRow'
import { SortableTape } from './SortableTape'

/**
 * The inbox: one continuous list in manual order. New tapes arrive at the top
 * and the list scrolls up to reveal them; any tape can be dragged before or after
 * any other. The order that backs the view, drag-reordering, keyboard navigation,
 * and removal all lives in lib/tapeOrder so they agree on which tape is next.
 */
export function TapeList() {
  const progress = useTapesStore((s) => s.progress)
  const selectedId = useSelectionStore((s) => s.selectedId)
  const select = useSelectionStore((s) => s.select)
  const filter = useFilterStore((s) => s.filter)
  const visible = useVisibleTapes()

  const [activeId, setActiveId] = useState<string | null>(null)
  const sensors = useTapeDragSensors()

  // Scroll the newly-added tape into view. New tapes land at the top, so a top
  // sentinel + scrollIntoView('nearest') reveals them when the list is scrolled
  // down and does nothing when the top is already showing. Adds come in over the
  // tapes:added event; the tick defers the scroll to after the new row renders.
  const topRef = useRef<HTMLDivElement>(null)
  const [addTick, setAddTick] = useState(0)
  useEffect(
    () =>
      ipcOn('tapes:added', (added) => {
        if (added.some((t) => !t.archivedAtUtc)) setAddTick((n) => n + 1)
      }),
    [],
  )
  useEffect(() => {
    if (addTick > 0) topRef.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
  }, [addTick])

  function onDragStart({ active }: DragStartEvent) {
    setActiveId(String(active.id))
  }

  function onDragEnd({ active, over }: DragEndEvent) {
    setActiveId(null)
    if (!over || active.id === over.id) return
    const from = visible.findIndex((t) => t.id === active.id)
    const to = visible.findIndex((t) => t.id === over.id)
    if (from < 0 || to < 0) return
    const reordered = arrayMove(visible, from, to)
    // Optimistically reindex, then persist the whole new sequence.
    useTapesStore.getState().upsertMany(reordered.map((t, i) => ({ ...t, order: i })))
    void ipcInvoke('tapes:reorder', { orderedIds: reordered.map((t) => t.id) })
  }

  if (visible.length === 0) {
    return <div className="p-6 text-sm text-zinc-300">{emptyMessageFor(filter)}</div>
  }

  const activeTape = activeId ? visible.find((t) => t.id === activeId) : undefined

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCenter}
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      onDragCancel={() => setActiveId(null)}
    >
      <div ref={topRef} />
      <SortableContext items={visible.map((t) => t.id)} strategy={verticalListSortingStrategy}>
        <ul className="space-y-1.5 p-3">
          {visible.map((tape) => (
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
      <DragOverlay>
        {activeTape ? (
          <TapeRow tape={activeTape} progress={progress[activeTape.id]} selected={false} onSelect={() => {}} />
        ) : null}
      </DragOverlay>
    </DndContext>
  )
}

function emptyMessageFor(filter: Filter): string {
  return filter === 'archived' ? 'No archived tapes yet.' : 'No tapes here yet.'
}
