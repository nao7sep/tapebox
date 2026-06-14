import { useState } from 'react'
import { useDndContext, useDroppable } from '@dnd-kit/core'
import { SortableContext, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { ipcInvoke } from '@renderer/ipc/client'
import { useTapesStore } from '@renderer/store/tapes'
import { useBoxesStore } from '@renderer/store/boxes'
import { useArchiveStore } from '@renderer/store/archive'
import { useNavStore } from '@renderer/store/nav'
import { useBoxKeyboard } from '@renderer/lib/useBoxKeyboard'
import { useRovingFocus } from '@renderer/lib/useRovingFocus'
import { useComposing, isComposingKeyboardEvent } from '@renderer/lib/useComposing'
import { boxNameError, UNBOXED_LABEL } from '@shared/box-names'
import { ConfirmModal } from './ConfirmModal'

/** Droppable id for the Unboxed row (it is not a real box, so it has no box id). */
export const UNBOXED_DROP_ID = '__unboxed__'

/**
 * Top list of the archive organizer: the boxes plus an always-present Unboxed
 * row, with counts, selection, create, inline rename, and delete. Boxes are
 * sortable (drag a header to reorder) and droppable (drag a tape onto a box to
 * file it); the parent DndContext owns the drag handling. Deleting a box only
 * re-files its tapes to Unboxed — it never removes the tapes.
 */
export function BoxList() {
  const boxes = useBoxesStore((s) => s.boxes)
  const tapes = useTapesStore((s) => s.tapes)
  const selectedBoxId = useArchiveStore((s) => s.selectedBoxId)
  const selectBox = useArchiveStore((s) => s.selectBox)
  const setActivePanel = useNavStore((s) => s.setActivePanel)
  // Clicking a box selects it AND makes the box list the active keyboard panel.
  const selectBoxPanel = (id: string | null) => { selectBox(id); setActivePanel('boxes') }
  useBoxKeyboard()

  const [editingId, setEditingId] = useState<string | null>(null)
  const [draftName, setDraftName] = useState('')
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null)
  const { composingRef, handlers: composing } = useComposing()

  const sorted = [...boxes].sort((a, b) => a.order - b.order)
  const archived = tapes.filter((i) => !!i.archivedAtUtc)
  const countOf = (boxId: string | null) => archived.filter((i) => i.boxId === boxId).length

  // Names of every box except the one being edited — what a rename collides with.
  const otherNames = (id: string) => sorted.filter((g) => g.id !== id).map((g) => g.name)

  // Live validation of the in-progress rename (empty = "about to cancel", not an error).
  const trimmedDraft = draftName.trim()
  const draftError =
    editingId !== null && trimmedDraft ? boxNameError(trimmedDraft, otherNames(editingId)) : null

  async function newBox() {
    const box = await ipcInvoke('boxes:create', { name: 'New box' })
    selectBoxPanel(box.id)
    setDraftName(box.name)
    setEditingId(box.id)
  }

  // Enter: commit when valid, stay editing when invalid, cancel when empty.
  async function commitRename(id: string) {
    const name = draftName.trim()
    if (!name) { setEditingId(null); return }
    if (boxNameError(name, otherNames(id))) return
    setEditingId(null)
    await ipcInvoke('boxes:rename', { boxId: id, name })
  }

  // Blur: a focus loss can't keep editing, so commit only when valid, else discard.
  function commitOrDiscard(id: string) {
    const name = draftName.trim()
    if (!name || boxNameError(name, otherNames(id))) { setEditingId(null); return }
    void commitRename(id)
  }

  async function deleteBox(id: string) {
    setConfirmDeleteId(null)
    if (selectedBoxId === id) selectBox(null)
    await ipcInvoke('boxes:delete', { boxId: id })
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 items-center justify-between px-3 py-2">
        <span className="text-xs font-medium uppercase tracking-wide text-zinc-400">Boxes</span>
        <button onClick={() => void newBox()} className="text-xs text-zinc-300 transition hover:text-zinc-100">
          + New box
        </button>
      </div>

      <div
        role="listbox"
        aria-label="Boxes"
        className="min-h-0 flex-1 space-y-0.5 overflow-y-auto px-2 pb-2"
      >
        <UnboxedRow count={countOf(null)} selected={selectedBoxId === null} onSelect={() => selectBoxPanel(null)} />
        <SortableContext items={sorted.map((g) => g.id)} strategy={verticalListSortingStrategy}>
          {sorted.map((g) =>
            editingId === g.id ? (
              <div key={g.id}>
                <input
                  autoFocus
                  value={draftName}
                  onFocus={(e) => e.currentTarget.select()}
                  onChange={(e) => setDraftName(e.target.value)}
                  onBlur={() => commitOrDiscard(g.id)}
                  onCompositionStart={composing.onCompositionStart}
                  onCompositionEnd={composing.onCompositionEnd}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && !isComposingKeyboardEvent(composingRef, e)) void commitRename(g.id)
                    else if (e.key === 'Escape') setEditingId(null)
                  }}
                  className={
                    'w-full rounded border bg-zinc-900 px-2 py-1 text-sm focus:outline-hidden ' +
                    (draftError
                      ? 'border-red-700 focus:border-red-600'
                      : 'border-zinc-700 focus:border-zinc-500')
                  }
                />
                {draftError && <p className="mt-0.5 px-1 text-xs text-red-300">{draftError}</p>}
              </div>
            ) : (
              <SortableBoxRow
                key={g.id}
                id={g.id}
                label={g.name}
                count={countOf(g.id)}
                selected={selectedBoxId === g.id}
                onSelect={() => selectBoxPanel(g.id)}
                onRename={() => { setDraftName(g.name); setEditingId(g.id) }}
                onDelete={() => setConfirmDeleteId(g.id)}
              />
            ),
          )}
        </SortableContext>
      </div>

      {confirmDeleteId && (
        <ConfirmModal
          title="Delete box"
          message="Delete this box? Its tapes move to Unboxed — the tapes themselves are not removed."
          confirmLabel="Delete box"
          danger
          onCancel={() => setConfirmDeleteId(null)}
          onConfirm={() => void deleteBox(confirmDeleteId)}
        />
      )}
    </div>
  )
}

/**
 * Box rows are flat (no border), so the selected box shows its emphasis the way a
 * flat item should — an accent fill, not a ring: it's effectively "which box you're
 * in", the home of the currently selected tape, so it should read clearly even
 * while the box list doesn't have focus, the way a Finder sidebar selection does.
 * (The bordered tape and chapter rows use a ring for the same reason — each item
 * emphasizes in its own affordance.)
 *
 * `dropTarget` — a tape being dragged over this box — is the ONLY drop affordance:
 * a bright filled ring saying "let go to file it here". It's suppressed on the
 * dragged tape's own box (the selected one, since tapes are only dragged from the
 * open list): dropping there is a no-op, so it shouldn't invite a drop. Reordering
 * a box (dragging a box, not a tape) gets no ring at all; the sortable list animates
 * the gap to show where it'll land, and a "drop into" ring there would falsely
 * suggest you could throw one box inside another.
 */
function rowClass(selected: boolean, dropTarget: boolean): string {
  return (
    'group flex items-center gap-1.5 rounded px-2 py-1.5 text-sm transition ' +
    (selected ? 'bg-sky-500/20 font-medium text-zinc-50 ' : 'text-zinc-300 hover:bg-zinc-800/50 ') +
    (dropTarget ? 'bg-sky-900/40 ring-2 ring-sky-400 ' : '')
  )
}

/** True while a tape (not a box) is the active drag — i.e. boxes are drop targets. */
function useDraggingTape(): boolean {
  const { active } = useDndContext()
  return active?.data.current?.type === 'tape'
}

function UnboxedRow({ count, selected, onSelect }: { count: number; selected: boolean; onSelect: () => void }) {
  const { setNodeRef, isOver } = useDroppable({ id: UNBOXED_DROP_ID })
  const draggingTape = useDraggingTape()
  // Focus follows the selection while the box list owns the keys, so it never lags
  // behind on a clicked row; the accent fill is the only marker (no focus outline).
  const active = useNavStore((s) => s.activePanel === 'boxes')
  const setActivePanel = useNavStore((s) => s.setActivePanel)
  const btnRef = useRovingFocus<HTMLButtonElement>(active, selected)
  return (
    <div ref={setNodeRef} role="presentation" className={rowClass(selected, isOver && draggingTape && !selected)}>
      <button
        ref={btnRef}
        role="option"
        aria-selected={selected}
        tabIndex={selected ? 0 : -1}
        onClick={onSelect}
        onFocus={() => setActivePanel('boxes')}
        className="min-w-0 flex-1 truncate text-left focus:outline-none"
      >
        {UNBOXED_LABEL}
      </button>
      <span className="shrink-0 text-xs tabular-nums text-zinc-400">{count}</span>
    </div>
  )
}

function SortableBoxRow({
  id,
  label,
  count,
  selected,
  onSelect,
  onRename,
  onDelete,
}: {
  id: string
  label: string
  count: number
  selected: boolean
  onSelect: () => void
  onRename: () => void
  onDelete: () => void
}) {
  // Spread dnd-kit's `listeners` (pointer drag) but NOT its `attributes`: those put
  // role="button" and a tab index on the row wrapper, which would add a second tab
  // stop and shadow the inner option. Keyboard reorder isn't enabled here.
  const { listeners, setNodeRef, transform, transition, isDragging, isOver } = useSortable({
    id,
    data: { type: 'box' },
  })
  const draggingTape = useDraggingTape()
  const active = useNavStore((s) => s.activePanel === 'boxes')
  const setActivePanel = useNavStore((s) => s.setActivePanel)
  const btnRef = useRovingFocus<HTMLButtonElement>(active, selected)
  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    // Hidden while dragging; the DragOverlay shows the moving copy.
    opacity: isDragging ? 0 : 1,
  }
  return (
    <div ref={setNodeRef} style={style} role="presentation" {...listeners} className={rowClass(selected, isOver && draggingTape && !selected)}>
      <button
        ref={btnRef}
        role="option"
        aria-selected={selected}
        tabIndex={selected ? 0 : -1}
        onClick={onSelect}
        onFocus={() => setActivePanel('boxes')}
        className="min-w-0 flex-1 truncate text-left focus:outline-none"
      >
        {label}
      </button>
      <button
        onClick={onRename}
        aria-label="Rename box"
        tabIndex={-1}
        className="hidden shrink-0 items-center justify-center rounded p-1 text-zinc-400 transition hover:bg-zinc-700/60 hover:text-zinc-200 group-hover:inline-flex"
      >
        <PencilGlyph />
      </button>
      <button
        onClick={onDelete}
        aria-label="Delete box"
        tabIndex={-1}
        className="hidden shrink-0 items-center justify-center rounded p-1 text-zinc-400 transition hover:bg-zinc-700/60 hover:text-red-300 group-hover:inline-flex"
      >
        <TrashGlyph />
      </button>
      {/* Extra left margin keeps the count clear of the delete button when the
          actions are revealed on hover, so the two don't read as one cluster. */}
      <span className="ml-1.5 shrink-0 text-xs tabular-nums text-zinc-400">{count}</span>
    </div>
  )
}

function PencilGlyph() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M12 20h9" />
      <path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z" />
    </svg>
  )
}

function TrashGlyph() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M3 6h18" />
      <path d="M8 6V4h8v2" />
      <path d="M6 6l1 14h10l1-14" />
    </svg>
  )
}
