import type { Tape } from '@shared/domain'
import { useVirtualRows } from '@renderer/lib/useVirtualRows'
import { useEffect, useMemo, useState, type RefObject } from 'react'
import type { DragEndEvent } from '@dnd-kit/react'
import { ipcInvoke, ipcOn } from '@renderer/ipc/client'
import { useTapesStore } from '@renderer/store/tapes'
import { useSelectionStore } from '@renderer/store/selection'
import { useFilterStore } from '@renderer/store/filter'
import { useOrderFailuresStore } from '@renderer/store/orderFailures'
import { useVisibleTapes } from '@renderer/lib/tapeOrder'
import { ListboxDragProvider, planTapeListDrop, useTapeDragPreview, useTapeDragSourceId } from '@renderer/lib/dnd'
import { isInSameTapeList, moveArrayItem, rollbackOptimisticOrder, settleOptimisticOrder } from '@renderer/lib/optimisticOrder'
import { useTapeListboxKeyboard } from '@renderer/lib/useTapeListboxKeyboard'
import { TapeRow } from './TapeRow'
import { SortableTape } from './SortableTape'
import { presentFailure } from '@renderer/lib/presentFailure'
import { InlineError } from './ui'
import { useI18n } from '@renderer/i18n/I18nContext'
import { message } from '@shared/i18n/translate'

/**
 * The inbox: one continuous list in manual order. New tapes arrive at the top
 * and the list scrolls up to reveal them; any tape can be dragged before or after
 * any other. The order that backs the view, drag-reordering, keyboard navigation,
 * and removal all lives in lib/tapeOrder so they agree on which tape is next.
 */
export function TapeList() {
  const selectedId = useSelectionStore((s) => s.selectedId)
  const filter = useFilterStore((s) => s.filter)
  const visible = useVisibleTapes()
  const orderError = useOrderFailuresStore((s) => s.inbox)
  const setOrderError = useOrderFailuresStore((s) => s.setInbox)
  const t = useI18n()

  const kb = useTapeListboxKeyboard<HTMLUListElement>(visible, selectedId, (id, offset) => {
    const from = visible.findIndex((t) => t.id === id)
    reorderTape(from, from + offset)
  })

  // Adds arrive over IPC; scroll the viewport after the new rows are committed.
  const [addTick, setAddTick] = useState(0)
  useEffect(
    () =>
      ipcOn('tapes:added', (added) => {
        if (added.some((t) => !t.archivedAtUtc)) setAddTick((n) => n + 1)
      }),
    [],
  )
  useEffect(() => {
    if (addTick > 0) kb.ref.current?.scrollTo({ top: 0, behavior: 'smooth' })
  }, [addTick])

  function onDragEnd(event: DragEndEvent, previewTargetId?: string) {
    const plan = planTapeListDrop(event, visible.map((tape) => tape.id), previewTargetId)
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
    const attempt = useOrderFailuresStore.getState().beginAttempt('inbox', visible)
    useTapesStore.getState().upsertMany(optimistic)
    settleOptimisticOrder(
      ipcInvoke('tapes:reorder', { orderedIds: reordered.map((t) => t.id) }),
      () => useOrderFailuresStore.getState().isCurrentAttempt('inbox', attempt),
      () => useTapesStore.setState((state) => ({
        tapes: rollbackOptimisticOrder(state.tapes, useOrderFailuresStore.getState().confirmedOrder('inbox'), optimistic, isInSameTapeList),
      })),
      () => setOrderError(null),
      (error) => setOrderError(presentFailure(error, message('tapes.orderSaveFailed'), 'tape order save failed')),
      () => useOrderFailuresStore.getState().finishAttempt('inbox', attempt),
    )
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {orderError && (
        <InlineError className="m-3 mb-0 shrink-0" onDismiss={() => setOrderError(null)} closeLabel={t.t('tapes.closeOrderResult')}>
          {t.text(orderError)}
        </InlineError>
      )}
      <div className="flex min-h-0 flex-1 flex-col">
        {visible.length === 0 ? (
          <div className="p-6 text-sm text-fg">{t.t(filter === 'archived' ? 'tapes.emptyArchived' : 'tapes.emptyInbox')}</div>
        ) : (
          <ListboxDragProvider onDragEnd={onDragEnd}>
            <ul
              ref={kb.ref}
              {...kb.listboxProps}
              role="listbox"
              aria-label={t.t('tapes.label')}
              className="relative min-h-0 flex-1 overflow-y-auto outline-none"
            >
              <TapeListItems tapes={visible} selectedId={selectedId} listRef={kb.ref} optionId={kb.optionId} />
            </ul>
          </ListboxDragProvider>
        )}
      </div>
    </div>
  )
}

function TapeListItems({ tapes: original, selectedId, listRef, optionId }: {
  tapes: Tape[]
  selectedId: string | null
  listRef: RefObject<HTMLUListElement | null>
  optionId: (id: string) => string
}) {
  const visible = useTapeDragPreview(original)
  const draggedId = useTapeDragSourceId()
  const originalIndices = useMemo(() => new Map(original.map((tape, index) => [tape.id, index])), [original])
  const virtualRows = useMemo(() => visible.map((tape, index) => ({ id: tape.id, estimate: 68, gap: index === visible.length - 1 ? 0 : 6 })), [visible])
  const virtual = useVirtualRows(virtualRows, listRef, selectedId, 12, draggedId)

  return (
    <li role="presentation" style={{ height: virtual.total, position: 'relative' }}>
      <ul role="presentation">
        {virtual.mounted.map((index) => {
          const tape = visible[index]!
          return (
            <SortableTape
              key={tape.id}
              id={tape.id}
              index={originalIndices.get(tape.id)!}
              style={{ position: 'absolute', top: virtual.offsets[index], left: 12, right: 12 }}
              measureRef={virtual.rowRef(tape.id)}
              onDragSource={virtual.onDragSource}
            >
              <TapeRow tape={tape} selected={tape.id === selectedId} id={optionId(tape.id)} />
            </SortableTape>
          )
        })}
      </ul>
    </li>
  )
}
