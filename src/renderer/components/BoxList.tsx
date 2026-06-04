import { useState } from 'react'
import { useDroppable } from '@dnd-kit/core'
import { SortableContext, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { ipcInvoke } from '@renderer/ipc/client'
import { useTapesStore } from '@renderer/store/tapes'
import { useBoxesStore } from '@renderer/store/boxes'
import { useArchiveStore } from '@renderer/store/archive'
import { boxNameError, LOOSE_LABEL } from '@shared/box-names'
import { ConfirmModal } from './ConfirmModal'

/** Droppable id for the Loose row (it is not a real box, so it has no box id). */
export const LOOSE_DROP_ID = '__loose__'

/**
 * Top list of the archive organizer: the boxes plus an always-present Loose
 * row, with counts, selection, create, inline rename, and delete. Boxes are
 * sortable (drag a header to reorder) and droppable (drag a tape onto a box to
 * file it); the parent DndContext owns the drag handling. Deleting a box only
 * re-files its tapes to Loose — it never removes the tapes.
 */
export function BoxList() {
  const boxes = useBoxesStore((s) => s.boxes)
  const tapes = useTapesStore((s) => s.tapes)
  const selectedBoxId = useArchiveStore((s) => s.selectedBoxId)
  const selectBox = useArchiveStore((s) => s.selectBox)

  const [editingId, setEditingId] = useState<string | null>(null)
  const [draftName, setDraftName] = useState('')
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null)

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
    selectBox(box.id)
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

      <div className="min-h-0 flex-1 space-y-0.5 overflow-y-auto px-2 pb-2">
        <LooseRow count={countOf(null)} selected={selectedBoxId === null} onSelect={() => selectBox(null)} />
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
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') void commitRename(g.id)
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
                onSelect={() => selectBox(g.id)}
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
          message="Delete this box? Its tapes move to Loose — the tapes themselves are not removed."
          confirmLabel="Delete box"
          danger
          onCancel={() => setConfirmDeleteId(null)}
          onConfirm={() => void deleteBox(confirmDeleteId)}
        />
      )}
    </div>
  )
}

function rowClass(selected: boolean, isOver: boolean): string {
  return (
    'box flex items-center gap-1.5 rounded px-2 py-1.5 text-sm transition ' +
    (selected ? 'bg-zinc-800 text-zinc-100 ' : 'text-zinc-300 hover:bg-zinc-800/50 ') +
    (isOver ? 'ring-1 ring-zinc-400' : '')
  )
}

function LooseRow({ count, selected, onSelect }: { count: number; selected: boolean; onSelect: () => void }) {
  const { setNodeRef, isOver } = useDroppable({ id: LOOSE_DROP_ID })
  return (
    <div ref={setNodeRef} className={rowClass(selected, isOver)}>
      <button onClick={onSelect} className="min-w-0 flex-1 truncate text-left">
        {LOOSE_LABEL}
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
  const { attributes, listeners, setNodeRef, transform, transition, isDragging, isOver } = useSortable({
    id,
    data: { type: 'box' },
  })
  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.4 : 1,
  }
  return (
    <div ref={setNodeRef} style={style} {...attributes} {...listeners} className={rowClass(selected, isOver)}>
      <button onClick={onSelect} className="min-w-0 flex-1 truncate text-left">
        {label}
      </button>
      <button onClick={onRename} aria-label="Rename box" className="hidden shrink-0 text-zinc-400 hover:text-zinc-200 box-hover:block">
        <PencilGlyph />
      </button>
      <button onClick={onDelete} aria-label="Delete box" className="hidden shrink-0 text-zinc-400 hover:text-red-300 box-hover:block">
        <TrashGlyph />
      </button>
      <span className="shrink-0 text-xs tabular-nums text-zinc-400">{count}</span>
    </div>
  )
}

function PencilGlyph() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M12 20h9" />
      <path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z" />
    </svg>
  )
}

function TrashGlyph() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M3 6h18" />
      <path d="M8 6V4h8v2" />
      <path d="M6 6l1 14h10l1-14" />
    </svg>
  )
}
