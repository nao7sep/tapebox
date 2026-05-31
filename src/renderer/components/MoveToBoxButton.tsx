import { useEffect, useRef, useState, type ReactNode } from 'react'
import type { Item } from '@shared/domain'
import { ipcInvoke } from '@renderer/ipc/client'
import { useGroupsStore } from '@renderer/store/groups'
import { UNGROUPED_LABEL } from '@shared/archive-names'

/**
 * Files an archived tape into a box (or Ungrouped, or a brand-new box) via a
 * small dropdown. This is the click/keyboard path; drag-and-drop hits the same
 * archive:placeItems. The menu opens upward since it lives in the bottom button
 * row.
 */
export function MoveToBoxButton({ item }: { item: Item }) {
  const groups = useGroupsStore((s) => s.groups)
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement | null>(null)
  const sorted = [...groups].sort((a, b) => a.order - b.order)

  useEffect(() => {
    if (!open) return
    function onDocMouseDown(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onDocMouseDown)
    window.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDocMouseDown)
      window.removeEventListener('keydown', onKey)
    }
  }, [open])

  async function moveTo(groupId: string | null) {
    setOpen(false)
    await ipcInvoke('archive:placeItems', { itemIds: [item.id], groupId, beforeItemId: null })
  }

  async function newBoxAndMove() {
    const group = await ipcInvoke('archive:createGroup', { name: 'New box' })
    setOpen(false)
    await ipcInvoke('archive:placeItems', { itemIds: [item.id], groupId: group.id, beforeItemId: null })
  }

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpen((v) => !v)}
        className="rounded border border-zinc-700 px-3 py-1.5 text-xs text-zinc-200 transition hover:border-zinc-500 hover:bg-zinc-800/60"
      >
        Move to box
      </button>
      {open && (
        <div className="absolute bottom-full z-40 mb-1 max-h-64 w-52 overflow-y-auto rounded-md border border-zinc-700 bg-zinc-900 py-1 shadow-xl">
          <MenuItem onClick={() => void moveTo(null)} active={item.groupId === null}>
            {UNGROUPED_LABEL}
          </MenuItem>
          {sorted.map((g) => (
            <MenuItem key={g.id} onClick={() => void moveTo(g.id)} active={item.groupId === g.id}>
              {g.name}
            </MenuItem>
          ))}
          <div className="my-1 border-t border-zinc-700" />
          <MenuItem onClick={() => void newBoxAndMove()}>+ New box</MenuItem>
        </div>
      )}
    </div>
  )
}

function MenuItem({ children, onClick, active }: { children: ReactNode; onClick: () => void; active?: boolean }) {
  return (
    <button
      onClick={onClick}
      className={
        'block w-full px-3 py-1.5 text-left text-sm transition ' +
        (active ? 'text-zinc-100' : 'text-zinc-300 hover:bg-zinc-800 hover:text-zinc-100')
      }
    >
      {active ? '✓ ' : ''}
      {children}
    </button>
  )
}
