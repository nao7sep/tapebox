import { useEffect, useRef } from 'react'
import { useFilterStore } from '@renderer/store/filter'
import { useShelfStore } from '@renderer/store/shelf'
import { useRuntimeStore } from '@renderer/store/runtime'
import { isEditableElement, isModalOpen } from '@renderer/lib/dom'
import { keyEventIsComposing } from '@renderer/lib/useComposing'
import { matchShortcut, SHORTCUTS } from '@renderer/lib/shortcuts'

/**
 * App-level navigation shortcuts — distinct from the per-list keys (useListboxKeyboard)
 * and per-tape keys (DetailPane):
 *   - ? or ⌘/Ctrl /  open the shortcuts list
 *   - ⌘/Ctrl 1 / 2   switch to Inbox / Archived
 *   - /              jump to the Archive and focus its search box
 *
 * A modal owning the keyboard suppresses everything, and so does a pending IME
 * composition: Cmd+1 mid-candidate would swap the Archive search box out from
 * under it. The guard returns without preventing default, so the field's own
 * handling still runs (text-input-ime-conventions). While typing, the bare keys
 * stand down (they are typed text), and on macOS so does the Ctrl half of a
 * mod-chord — Ctrl belongs to the text system there; the Cmd half is the binding
 * and always fires (keyboard-shortcut-conventions). The listener attaches once;
 * store actions are read fresh via getState, and the shortcuts-modal opener is
 * read through a ref so a fresh closure each render never re-binds the listener.
 */
export function useAppShortcuts(onShowShortcuts: () => void): void {
  const onShowRef = useRef(onShowShortcuts)
  onShowRef.current = onShowShortcuts

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent): void {
      if (e.defaultPrevented || keyEventIsComposing(e) || isModalOpen()) return
      const typing = isEditableElement(e.target)
      const isMac = useRuntimeStore.getState().info?.platform === 'darwin'
      const modChordStandsDown = typing && isMac && e.ctrlKey && !e.metaKey

      // Cmd/Ctrl+/ and "?" open the same list (keyboard-shortcut-conventions).
      const showList = matchShortcut(SHORTCUTS.showList, e)
      if (showList >= 0) {
        if (showList === 0 ? modChordStandsDown : typing) return
        e.preventDefault()
        onShowRef.current()
      } else if (matchShortcut(SHORTCUTS.inbox, e) >= 0 || matchShortcut(SHORTCUTS.shelf, e) >= 0) {
        if (modChordStandsDown) return
        e.preventDefault()
        useFilterStore.getState().setFilter(matchShortcut(SHORTCUTS.inbox, e) >= 0 ? 'inbox' : 'shelf')
      } else if (matchShortcut(SHORTCUTS.searchShelf, e) >= 0) {
        if (typing) return
        e.preventDefault()
        useFilterStore.getState().setFilter('shelf')
        useShelfStore.getState().setPendingSearchFocus(true)
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])
}
