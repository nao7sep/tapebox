import { useEffect, useRef } from 'react'
import type { Tape } from '@shared/domain'
import { useSelectionStore } from '@renderer/store/selection'
import { useVisibleTapes } from '@renderer/lib/tapeOrder'
import { isShortcutBlocked } from '@renderer/lib/dom'
import { archiveTape, unarchiveTape } from '@renderer/lib/tapeActions'

/**
 * Global keyboard navigation for the tape list:
 *   - ↑ / ↓ move the selection through the on-screen order;
 *   - A toggles archive / unarchive on the selected tape;
 *   - Backspace / Delete (with or without ⌘/Ctrl) remove the selected tape.
 *
 * A and Backspace use the 'list' policy (selection advances to a neighbor), so the
 * user can triage a list without their hands leaving the keys. All three are
 * suppressed while typing in a field or while a modal is open; arrows are also
 * suppressed while the <video> is focused, so the player keeps its volume/seek keys.
 * The listener is attached once; live state is read through a ref so navigation
 * never re-binds on every render.
 */
export function useListKeyboard(requestRemove: (tape: Tape) => void): void {
  const visible = useVisibleTapes()
  const selectedId = useSelectionStore((s) => s.selectedId)
  const select = useSelectionStore((s) => s.select)

  const stateRef = useRef({ visible, selectedId, select, requestRemove })
  stateRef.current = { visible, selectedId, select, requestRemove }

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent): void {
      if (e.defaultPrevented || isShortcutBlocked(e.target)) return

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

      // A toggles archive/unarchive on the selected tape. Plain 'a' only — never
      // hijack ⌘/Ctrl+A (select all). The layer no-ops if the action doesn't apply
      // (e.g. archiving a tape that isn't downloaded), mirroring the buttons.
      if ((e.key === 'a' || e.key === 'A') && !e.metaKey && !e.ctrlKey && !e.altKey) {
        if (!selectedId) return
        const tape = visible.find((i) => i.id === selectedId)
        if (!tape) return
        e.preventDefault()
        if (tape.archivedAtUtc) unarchiveTape(tape, 'list')
        else archiveTape(tape, 'list')
        return
      }

      if (e.key === 'Backspace' || e.key === 'Delete') {
        if (!selectedId) return
        const tape = visible.find((i) => i.id === selectedId)
        if (!tape) return
        e.preventDefault()
        requestRemove(tape)
      }
    }

    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])
}

function isVideo(el: Element | null): boolean {
  return el instanceof HTMLVideoElement
}
