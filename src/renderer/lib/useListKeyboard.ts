import { useEffect, useRef } from 'react'
import type { Tape } from '@shared/domain'
import { useSelectionStore } from '@renderer/store/selection'
import { useNavStore } from '@renderer/store/nav'
import { useVisibleTapes } from '@renderer/lib/tapeOrder'
import { isShortcutBlocked } from '@renderer/lib/dom'
import { nextIndex } from '@renderer/lib/nextIndex'
import { archiveTape, unarchiveTape } from '@renderer/lib/tapeActions'

/**
 * Global keyboard navigation for the video list:
 *   - ↑ / ↓ move the selection through the on-screen order;
 *   - A toggles archive / unarchive on the selected tape;
 *   - Backspace / Delete (with or without ⌘/Ctrl) remove the selected tape.
 *
 * A and Backspace use the 'list' policy (selection advances to a neighbor), so the
 * user can triage a list without their hands leaving the keys. All of these act
 * only while the video list is the active panel — when the chapter or box list owns
 * the keys (the user clicked into it), this layer stands down entirely, so Up/Down
 * and the tape actions never fire from another pane. They're also suppressed while
 * typing in a field or while a modal is open. The listener is attached once; live
 * state is read through a ref so navigation never re-binds on every render.
 */
export function useListKeyboard(requestRemove: (tape: Tape) => void): void {
  const visible = useVisibleTapes()
  const selectedId = useSelectionStore((s) => s.selectedId)
  const select = useSelectionStore((s) => s.select)
  const activePanel = useNavStore((s) => s.activePanel)

  const stateRef = useRef({ visible, selectedId, select, requestRemove, activePanel })
  stateRef.current = { visible, selectedId, select, requestRemove, activePanel }

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent): void {
      if (e.defaultPrevented || isShortcutBlocked(e.target)) return

      const { visible, selectedId, select, requestRemove, activePanel } = stateRef.current
      // Only the active panel responds; the chapter/box layers own their own keys.
      if (activePanel !== 'tapes') return

      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        if (visible.length === 0) return
        e.preventDefault()
        const idx = visible.findIndex((i) => i.id === selectedId)
        select(visible[nextIndex(idx, visible.length, e.key === 'ArrowDown' ? 1 : -1)].id)
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
