import { useEffect, useRef, useState } from 'react'
import {
  DndContext,
  DragOverlay,
  closestCenter,
  type DragEndEvent,
  type DragStartEvent,
} from '@dnd-kit/core'
import { arrayMove } from '@dnd-kit/sortable'
import {
  LAYOUT_BOUNDS,
  archiveLowerListMin,
  ARCHIVE_SEARCH_BOX_HEIGHT,
  clampSplitter,
} from '@shared/layout'
import { ipcInvoke } from '@renderer/ipc/client'
import { useTapesStore } from '@renderer/store/tapes'
import { useBoxesStore } from '@renderer/store/boxes'
import { useArchiveStore } from '@renderer/store/archive'
import { useLayoutStore, patchLayout } from '@renderer/store/layout'
import { useVisibleTapes } from '@renderer/lib/tapeOrder'
import { useTapeDragSensors } from '@renderer/lib/dnd'
import { moveTapeToBox } from '@renderer/lib/tapeActions'
import { BoxList, UNBOXED_DROP_ID } from './BoxList'
import { ArchiveTapeList } from './ArchiveTapeList'
import { SearchResults } from './SearchResults'
import { ResizeHandle } from './ResizeHandle'
import { TapeRow } from './TapeRow'

/**
 * The archived view's left-pane layout and drag handling: boxes on top, the
 * selected box's tapes below. One DndContext covers both lists so a tape can be
 * dragged from the lower list onto a box in the upper one. Drags update the
 * stores optimistically, then persist via boxes:place / boxes:reorder /
 * tapes:reorder (the IPC re-emits the authoritative state).
 */
export function ArchiveOrganizer() {
  const boxes = useBoxesStore((s) => s.boxes)
  const query = useArchiveStore((s) => s.query)
  const setQuery = useArchiveStore((s) => s.setQuery)
  const pendingSearchFocus = useArchiveStore((s) => s.pendingSearchFocus)
  const setPendingSearchFocus = useArchiveStore((s) => s.setPendingSearchFocus)
  const boxesHeight = useLayoutStore((s) => s.layout.archiveBoxesHeight)
  const progress = useTapesStore((s) => s.progress)
  const tapes = useVisibleTapes()
  const searching = query.trim().length > 0

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

  // Re-clamp the rendered boxes height against the live pane (window-chrome-
  // conventions require re-clamping on resize and when restoring a persisted
  // value): a window smaller than last run could otherwise let a tall stored
  // height swallow the lower list and shove its separator off-screen. This is a
  // graceful refinement layered on a guaranteed-sufficient floor — the window
  // minimum already reserves the whole content row, so the cap only narrows a
  // *persisted* height that was saved larger on a bigger window, never the
  // already-protected minimum, and the stored preference is untouched (it returns
  // in full when the window grows). The reserve is derived from named sibling
  // minimums (search box + lower list), not a hand-typed magic number.
  const paneRef = useRef<HTMLDivElement>(null)
  const [paneHeight, setPaneHeight] = useState<number | null>(null)
  useEffect(() => {
    const el = paneRef.current
    if (!el) return
    const ro = new ResizeObserver(() => setPaneHeight(el.clientHeight))
    ro.observe(el)
    setPaneHeight(el.clientHeight)
    return () => ro.disconnect()
  }, [])
  const siblingMin = ARCHIVE_SEARCH_BOX_HEIGHT + archiveLowerListMin.min
  const effectiveBoxesHeight =
    paneHeight != null
      ? clampSplitter(boxesHeight, {
          available: paneHeight,
          siblingMin,
          min: LAYOUT_BOUNDS.archiveBoxesHeight.min,
          max: LAYOUT_BOUNDS.archiveBoxesHeight.max,
        })
      : boxesHeight

  // What's being dragged, so a DragOverlay can render a copy that follows the
  // cursor unclipped — without it, dragging a tape up over the boxes list pulls
  // it out of its scroll container and it visually vanishes.
  const [activeDrag, setActiveDrag] = useState<{ type: 'tape' | 'box'; id: string } | null>(null)
  const draggedTape = activeDrag?.type === 'tape' ? tapes.find((t) => t.id === activeDrag.id) : undefined
  const draggedBox = activeDrag?.type === 'box' ? boxes.find((b) => b.id === activeDrag.id) : undefined

  const sensors = useTapeDragSensors()

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
      // Dropped onto a box header (or Unboxed) → file it there. Drag uses the 'list'
      // policy: the tape leaves the current list (optimistically, so it doesn't snap
      // back then vanish) and selection advances to a neighbor if it was selected.
      // Dropping on its own box is a no-op (moveTapeToBox guards it).
      if (overType === 'box' || overId === UNBOXED_DROP_ID) {
        const boxId = overId === UNBOXED_DROP_ID ? null : overId
        const moving = tapes.find((t) => t.id === activeId)
        if (moving) moveTapeToBox(moving, boxId, 'list')
        return
      }
      // Dropped onto another tape → reorder within the current box. Optimistically
      // reindex the visible list, then persist the whole new sequence.
      if (overType === 'tape' && activeId !== overId) {
        const from = tapes.findIndex((t) => t.id === activeId)
        const to = tapes.findIndex((t) => t.id === overId)
        if (from < 0 || to < 0) return
        const reordered = arrayMove(tapes, from, to)
        useTapesStore.getState().upsertMany(reordered.map((t, i) => ({ ...t, order: i })))
        void ipcInvoke('tapes:reorder', { orderedIds: reordered.map((t) => t.id) })
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
          <BoxList />
          <ResizeHandle
            edge="bottom"
            size={effectiveBoxesHeight}
            min={LAYOUT_BOUNDS.archiveBoxesHeight.min}
            max={LAYOUT_BOUNDS.archiveBoxesHeight.max}
            // Reserve the search box and the lower list's minimum below, so
            // dragging the boxes taller can't push the lower list off-screen —
            // the live counterpart of the render-time clamp above.
            siblingMin={siblingMin}
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
