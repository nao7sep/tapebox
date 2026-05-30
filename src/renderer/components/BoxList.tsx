import { useState } from 'react'
import { useDroppable } from '@dnd-kit/core'
import { SortableContext, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { ipcInvoke } from '@renderer/ipc/client'
import { useItemsStore } from '@renderer/store/items'
import { useGroupsStore } from '@renderer/store/groups'
import { useArchiveStore } from '@renderer/store/archive'
import { ConfirmModal } from './ConfirmModal'

/** Droppable id for the Ungrouped row (it is not a real box, so it has no group id). */
export const UNGROUPED_DROP_ID = '__ungrouped__'

/**
 * Top list of the archive organizer: the boxes plus an always-present Ungrouped
 * row, with counts, selection, create, inline rename, and delete. Boxes are
 * sortable (drag a header to reorder) and droppable (drag a tape onto a box to
 * file it); the parent DndContext owns the drag handling. Deleting a box only
 * re-files its tapes to Ungrouped — it never removes the tapes.
 */
export function BoxList() {
  const groups = useGroupsStore((s) => s.groups)
  const items = useItemsStore((s) => s.items)
  const selectedGroupId = useArchiveStore((s) => s.selectedGroupId)
  const selectGroup = useArchiveStore((s) => s.selectGroup)

  const [editingId, setEditingId] = useState<string | null>(null)
  const [draftName, setDraftName] = useState('')
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null)

  const sorted = [...groups].sort((a, b) => a.order - b.order)
  const archived = items.filter((i) => !!i.archivedAtUtc)
  const countOf = (groupId: string | null) => archived.filter((i) => i.groupId === groupId).length

  async function newBox() {
    const group = await ipcInvoke('archive:createGroup', { name: 'New box' })
    selectGroup(group.id)
    setDraftName(group.name)
    setEditingId(group.id)
  }

  async function commitRename(id: string) {
    const name = draftName.trim()
    setEditingId(null)
    if (name) await ipcInvoke('archive:renameGroup', { groupId: id, name })
  }

  async function deleteBox(id: string) {
    setConfirmDeleteId(null)
    if (selectedGroupId === id) selectGroup(null)
    await ipcInvoke('archive:deleteGroup', { groupId: id })
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 items-center justify-between px-3 py-2">
        <span className="text-xs font-medium uppercase tracking-wide text-zinc-500">Boxes</span>
        <button onClick={() => void newBox()} className="text-xs text-zinc-400 transition hover:text-zinc-100">
          + New box
        </button>
      </div>

      <div className="min-h-0 flex-1 space-y-0.5 overflow-y-auto px-2 pb-2">
        <UngroupedRow count={countOf(null)} selected={selectedGroupId === null} onSelect={() => selectGroup(null)} />
        <SortableContext items={sorted.map((g) => g.id)} strategy={verticalListSortingStrategy}>
          {sorted.map((g) =>
            editingId === g.id ? (
              <input
                key={g.id}
                autoFocus
                value={draftName}
                onChange={(e) => setDraftName(e.target.value)}
                onBlur={() => void commitRename(g.id)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void commitRename(g.id)
                  else if (e.key === 'Escape') setEditingId(null)
                }}
                className="w-full rounded border border-zinc-700 bg-zinc-900 px-2 py-1 text-sm focus:border-zinc-500 focus:outline-hidden"
              />
            ) : (
              <SortableBoxRow
                key={g.id}
                id={g.id}
                label={g.name}
                count={countOf(g.id)}
                selected={selectedGroupId === g.id}
                onSelect={() => selectGroup(g.id)}
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
          message="Delete this box? Its tapes move to Ungrouped — the tapes themselves are not removed."
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
    'group flex items-center gap-1.5 rounded px-2 py-1.5 text-sm transition ' +
    (selected ? 'bg-zinc-800 text-zinc-100 ' : 'text-zinc-300 hover:bg-zinc-800/50 ') +
    (isOver ? 'ring-1 ring-zinc-400' : '')
  )
}

function UngroupedRow({ count, selected, onSelect }: { count: number; selected: boolean; onSelect: () => void }) {
  const { setNodeRef, isOver } = useDroppable({ id: UNGROUPED_DROP_ID })
  return (
    <div ref={setNodeRef} className={rowClass(selected, isOver)}>
      <button onClick={onSelect} className="min-w-0 flex-1 truncate text-left">
        Ungrouped
      </button>
      <span className="shrink-0 text-xs tabular-nums text-zinc-500">{count}</span>
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
      <button onClick={onRename} aria-label="Rename box" className="hidden shrink-0 text-zinc-500 hover:text-zinc-200 group-hover:block">
        <PencilGlyph />
      </button>
      <button onClick={onDelete} aria-label="Delete box" className="hidden shrink-0 text-zinc-500 hover:text-red-300 group-hover:block">
        <TrashGlyph />
      </button>
      <span className="shrink-0 text-xs tabular-nums text-zinc-500">{count}</span>
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
