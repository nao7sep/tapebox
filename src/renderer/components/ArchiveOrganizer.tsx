import { useEffect, useRef } from 'react'
import type { DragEndEvent } from '@dnd-kit/react'
import {
  LAYOUT_BOUNDS,
  archiveLowerListMin,
  ARCHIVE_SEARCH_BOX_HEIGHT,
} from '@shared/layout'
import { ipcInvoke } from '@renderer/ipc/client'
import { useTapesStore } from '@renderer/store/tapes'
import { useBoxesStore } from '@renderer/store/boxes'
import { useArchiveStore } from '@renderer/store/archive'
import { useLayoutStore, patchLayout } from '@renderer/store/layout'
import { usePaneSize } from '@renderer/lib/usePaneSize'
import { useVisibleTapes } from '@renderer/lib/tapeOrder'
import { ListboxDragProvider, planArchiveDrop } from '@renderer/lib/dnd'
import { moveArrayItem, settleOptimisticOrder } from '@renderer/lib/optimisticOrder'
import { useOrderFailuresStore } from '@renderer/store/orderFailures'
import { presentFailure } from '@renderer/lib/presentFailure'
import { moveTapeToBox } from '@renderer/lib/tapeActions'
import { BoxList } from './BoxList'
import { ArchiveTapeList } from './ArchiveTapeList'
import { SearchResults } from './SearchResults'
import { ResizeHandle } from './ResizeHandle'

/**
 * The archived view's left-pane layout and drag handling: boxes on top, the
 * selected box's tapes below. One provider covers both lists so a tape can be
 * dragged from the lower list onto a box in the upper one. Drags update the
 * stores optimistically, then persist via boxes:place / boxes:reorder /
 * tapes:reorder (the IPC re-emits the authoritative state).
 */
export function ArchiveOrganizer() {
  const boxes = useBoxesStore((s) => s.boxes)
  const query = useArchiveStore((s) => s.query)
  const selectedBoxId = useArchiveStore((s) => s.selectedBoxId)
  const setQuery = useArchiveStore((s) => s.setQuery)
  const pendingSearchFocus = useArchiveStore((s) => s.pendingSearchFocus)
  const setPendingSearchFocus = useArchiveStore((s) => s.setPendingSearchFocus)
  const boxesIntent = useLayoutStore((s) => s.layout.archiveBoxesHeight)
  const tapes = useVisibleTapes()
  const searching = query.trim().length > 0
  const boxOrderError = useOrderFailuresStore((s) => s.boxes)
  const setBoxOrderError = useOrderFailuresStore((s) => s.setBoxes)
  const tapeListKey = selectedBoxId === null ? 'unboxed' : `box:${selectedBoxId}`
  const tapeOrderError = useOrderFailuresStore((s) => s.archiveTapes[tapeListKey] ?? null)
  const setTapeOrderError = useOrderFailuresStore((s) => s.setArchiveTapes)

  // Consume the one-shot focus request from the "/" shortcut: focus + select the
  // search box, then clear the flag. Runs on mount too (when "/" was pressed from
  // the Inbox and this view just appeared), so the cursor lands in search either way.
  const searchRef = useRef<HTMLInputElement>(null)
  useEffect(() => {
    if (!pendingSearchFocus) return
    searchRef.current?.focus()
    searchRef.current?.select()
    setPendingSearchFocus(false)
  }, [pendingSearchFocus, setPendingSearchFocus])

  // The persisted archiveBoxesHeight is the drag-set INTENT; the DISPLAYED height
  // is derived from it and the live pane (window-chrome-conventions: re-clamp on
  // resize and when restoring a persisted value). A window smaller than last run
  // narrows the *display* toward the boxes minimum so a tall intent can't swallow
  // the lower list and shove its separator off-screen; the intent is untouched
  // and returns in full when the window grows. Display-only — only a splitter
  // drag persists. The far-side reserve is derived from named sibling minimums
  // (search box + lower list), not a hand-typed magic number.
  const siblingMin = ARCHIVE_SEARCH_BOX_HEIGHT + archiveLowerListMin.min
  const { containerRef: paneRef, displayed: effectiveBoxesHeight } = usePaneSize<HTMLDivElement>(
    boxesIntent,
    true,
    {
      siblingMin,
      min: LAYOUT_BOUNDS.archiveBoxesHeight.min,
      max: LAYOUT_BOUNDS.archiveBoxesHeight.max,
    },
  )

  function onDragEnd(event: DragEndEvent) {
    const plan = planArchiveDrop(event)
    if (!plan) return
    if (plan.kind === 'reorder-box') {
      reorderBox(plan.boxId, plan.toIndex)
    } else if (plan.kind === 'reorder-tape') {
      reorderTape(plan.tapeId, plan.toIndex)
    } else {
      // Moving to a box uses the list policy: the tape leaves this list and
      // selection advances to its neighbor. The durable operation guards a
      // release onto the tape's current box as a no-op.
      const moving = tapes.find((tape) => tape.id === plan.tapeId)
      if (moving) moveTapeToBox(moving, plan.boxId, 'list')
    }
  }

  function sortedBoxIds(): string[] {
    return [...boxes].sort((a, b) => a.order - b.order).map((box) => box.id)
  }

  function reorderBox(activeId: string, to: number) {
    const ids = sortedBoxIds()
    const from = ids.indexOf(activeId)
    if (from < 0 || to < 0 || to >= ids.length || from === to) return
    const next = moveArrayItem(ids, from, to)
    const orderById = new Map(next.map((id, i) => [id, i]))
    const optimistic = boxes.map((box) => ({ ...box, order: orderById.get(box.id) ?? box.order }))
    useBoxesStore.getState().setBoxes(optimistic)
    settleOptimisticOrder(
      ipcInvoke('boxes:reorder', { orderedIds: next }),
      () => {
        const current = useBoxesStore.getState().boxes
        return optimistic.every((candidate) =>
          current.some((box) => box.id === candidate.id && box.order === candidate.order),
        )
      },
      () => useBoxesStore.getState().setBoxes(boxes),
      () => setBoxOrderError(null),
      (error) => setBoxOrderError(presentFailure(error, 'The box order was not saved. The previous order remains in use; try again.', 'box order save failed')),
    )
  }

  function reorderTape(activeId: string, to: number) {
    const from = tapes.findIndex((tape) => tape.id === activeId)
    if (from < 0 || to < 0 || to >= tapes.length || from === to) return
    const reordered = moveArrayItem(tapes, from, to)
    const optimistic = reordered.map((tape, i) => ({ ...tape, order: i }))
    useTapesStore.getState().upsertMany(optimistic)
    settleOptimisticOrder(
      ipcInvoke('tapes:reorder', { orderedIds: reordered.map((tape) => tape.id) }),
      () => {
        const current = useTapesStore.getState().tapes
        return optimistic.every((candidate) =>
          current.some((tape) => tape.id === candidate.id && tape.order === candidate.order),
        )
      },
      () => useTapesStore.getState().upsertMany(tapes),
      () => setTapeOrderError(tapeListKey, null),
      (error) => setTapeOrderError(tapeListKey, presentFailure(error, 'The tape order was not saved. The previous order remains in use; try again.', 'archive tape order save failed')),
    )
  }

  return (
    <ListboxDragProvider onDragEnd={onDragEnd}>
      <div ref={paneRef} className="flex min-h-0 flex-1 flex-col">
        <div className="shrink-0 px-3 py-2">
          <input
            ref={searchRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search archived…"
            spellCheck={false}
            className="w-full rounded border border-zinc-700 bg-zinc-900 px-2.5 py-1.5 text-sm placeholder-zinc-500 focus:border-zinc-600 focus:outline-hidden"
          />
        </div>
        <div className="relative flex shrink-0 flex-col border-b border-zinc-700" style={{ height: effectiveBoxesHeight }}>
          <BoxList
            onReorder={(id, offset) => reorderBox(id, sortedBoxIds().indexOf(id) + offset)}
            orderError={boxOrderError}
            onDismissOrderError={() => setBoxOrderError(null)}
          />
          <ResizeHandle
            edge="bottom"
            // Start from the displayed height; the handle reports the new INTENT,
            // persisted on commit. The displayed height re-derives from that
            // intent against the live pane (the clamp above).
            size={effectiveBoxesHeight}
            min={LAYOUT_BOUNDS.archiveBoxesHeight.min}
            max={LAYOUT_BOUNDS.archiveBoxesHeight.max}
            onResize={(h) => patchLayout({ archiveBoxesHeight: h }, false)}
            onCommit={(h) => patchLayout({ archiveBoxesHeight: h }, true)}
          />
        </div>
        <div className="flex min-h-0 flex-1 flex-col">
          {searching ? (
            <SearchResults />
          ) : (
            <ArchiveTapeList
              orderError={tapeOrderError}
              onDismissOrderError={() => setTapeOrderError(tapeListKey, null)}
              onReorder={(id, offset) => {
                const from = tapes.findIndex((tape) => tape.id === id)
                reorderTape(id, from + offset)
              }}
            />
          )}
        </div>
      </div>
    </ListboxDragProvider>
  )
}
