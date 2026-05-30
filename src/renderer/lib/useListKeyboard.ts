import { useEffect, useRef } from 'react'
import type { Item } from '@shared/domain'
import { useSelectionStore } from '@renderer/store/selection'
import { useVisibleItems } from '@renderer/lib/itemOrder'

/**
 * Global keyboard navigation for the item list:
 *   - ↑ / ↓ move the selection through the on-screen order;
 *   - Backspace / Delete (with or without ⌘/Ctrl) remove the selected tape.
 *
 * Suppressed while typing in a field, while a modal is open, or — for arrows
 * only — while the <video> is focused, so the player keeps its native volume
 * and seek keys. The listener is attached once; live state is read through a
 * ref so navigation never re-binds on every render.
 */
export function useListKeyboard(requestRemove: (item: Item) => void): void {
  const visible = useVisibleItems()
  const selectedId = useSelectionStore((s) => s.selectedId)
  const select = useSelectionStore((s) => s.select)

  const stateRef = useRef({ visible, selectedId, select, requestRemove })
  stateRef.current = { visible, selectedId, select, requestRemove }

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent): void {
      if (e.defaultPrevented) return
      // A modal is open — let it own the keyboard.
      if (document.querySelector('[data-dialog-surface]')) return
      if (isEditable(e.target)) return

      const { visible, selectedId, select, requestRemove } = stateRef.current

      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        // Don't hijack the player's own volume/seek keys when it's focused.
        if (isVideo(document.activeElement)) return
        if (visible.length === 0) return
        e.preventDefault()
        const idx = visible.findIndex((i) => i.id === selectedId)
        const nextIdx =
          e.key === 'ArrowDown'
            ? idx === -1 ? 0 : Math.min(idx + 1, visible.length - 1)
            : idx === -1 ? visible.length - 1 : Math.max(idx - 1, 0)
        select(visible[nextIdx].id)
        return
      }

      if (e.key === 'Backspace' || e.key === 'Delete') {
        if (!selectedId) return
        const item = visible.find((i) => i.id === selectedId)
        if (!item) return
        e.preventDefault()
        requestRemove(item)
      }
    }

    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])
}

function isEditable(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  const tag = target.tagName
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target.isContentEditable
}

function isVideo(el: Element | null): boolean {
  return el instanceof HTMLVideoElement
}
