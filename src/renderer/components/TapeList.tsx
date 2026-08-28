import { useEffect, useRef, useState } from 'react'
import type { DragEndEvent } from '@dnd-kit/react'
import { ipcInvoke, ipcOn } from '@renderer/ipc/client'
import { useTapesStore } from '@renderer/store/tapes'
import { useSelectionStore } from '@renderer/store/selection'
import { useFilterStore, type Filter } from '@renderer/store/filter'
import { useToastStore } from '@renderer/store/toast'
import { useVisibleTapes } from '@renderer/lib/tapeOrder'
import { ListboxDragProvider, planTapeListDrop } from '@renderer/lib/dnd'
import { moveArrayItem, settleOptimisticOrder } from '@renderer/lib/optimisticOrder'
import { selectTape } from '@renderer/lib/selectTape'
import { useTapeListboxKeyboard } from '@renderer/lib/useTapeListboxKeyboard'
import { TapeRow } from './TapeRow'
import { SortableTape } from './SortableTape'
import { errorMessage } from '@shared/error'

/**
 * The inbox: one continuous list in manual order. New tapes arrive at the top
 * and the list scrolls up to reveal them; any tape can be dragged before or after
 * any other. The order that backs the view, drag-reordering, keyboard navigation,
 * and removal all lives in lib/tapeOrder so they agree on which tape is next.
 */
export function TapeList() {
  const progress = useTapesStore((s) => s.progress)
  const selectedId = useSelectionStore((s) => s.selectedId)
  const filter = useFilterStore((s) => s.filter)
  const visible = useVisibleTapes()

  const kb = useTapeListboxKeyboard<HTMLUListElement>(visible, selectedId, (id, offset) => {
    const from = visible.findIndex((t) => t.id === id)
    reorderTape(from, from + offset)
  })

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

  function onDragEnd(event: DragEndEvent) {
    const plan = planTapeListDrop(event)
    if (plan) {
      // Resolve the source by stable identity at commit time in case an IPC
      // update changed the visible collection during the pointer session.
      reorderTape(visible.findIndex((tape) => tape.id === plan.tapeId), plan.toIndex)
    }
  }

  function reorderTape(from: number, to: number) {
    if (from < 0 || to < 0 || to >= visible.length || from === to) return
    const reordered = moveArrayItem(visible, from, to)
    // Pointer and keyboard reorder share this one optimistic + durable operation.
    const optimistic = reordered.map((t, i) => ({ ...t, order: i }))
    useTapesStore.getState().upsertMany(optimistic)
    settleOptimisticOrder(
      ipcInvoke('tapes:reorder', { orderedIds: reordered.map((t) => t.id) }),
      () => {
        const current = useTapesStore.getState().tapes
        return optimistic.every((candidate) =>
          current.some((tape) => tape.id === candidate.id && tape.order === candidate.order),
        )
      },
      () => useTapesStore.getState().upsertMany(visible),
      (error) => useToastStore.getState().notify(`Could not save tape order: ${errorMessage(error)}`, 'error'),
    )
  }

  if (visible.length === 0) {
    return <div className="p-6 text-sm text-zinc-300">{emptyMessageFor(filter)}</div>
  }

  return (
    <ListboxDragProvider onDragEnd={onDragEnd}>
      <div ref={topRef} />
      <ul
        ref={kb.ref}
        {...kb.listboxProps}
        role="listbox"
        aria-label="Tapes"
        className="space-y-1.5 p-3 outline-none"
      >
        {visible.map((tape, index) => (
          <SortableTape key={tape.id} id={tape.id} index={index}>
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
    </ListboxDragProvider>
  )
}

function emptyMessageFor(filter: Filter): string {
  return filter === 'archived' ? 'No archived tapes yet.' : 'No tapes here yet.'
}
