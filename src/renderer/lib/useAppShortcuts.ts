import { useEffect, useRef } from 'react'
import { useFilterStore } from '@renderer/store/filter'
import { useArchiveStore } from '@renderer/store/archive'
import { useRuntimeStore } from '@renderer/store/runtime'
import { isEditableElement, isModalOpen } from '@renderer/lib/dom'

/**
 * App-level navigation shortcuts — distinct from the per-list keys (useListboxKeyboard)
 * and per-tape keys (DetailPane):
 *   - ? or ⌘/Ctrl /  open the shortcuts list
 *   - ⌘/Ctrl 1 / 2   switch to Inbox / Archived
 *   - /              jump to the Archive and focus its search box
 *
 * A modal owning the keyboard suppresses everything. While typing, the bare keys
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
      if (e.defaultPrevented || isModalOpen()) return
      const typing = isEditableElement(e.target)
      const isMac = useRuntimeStore.getState().info?.platform === 'darwin'
      const modChordStandsDown = typing && isMac && e.ctrlKey && !e.metaKey
      const mod = (e.metaKey || e.ctrlKey) && !e.altKey

      // "?" first, then Cmd/Ctrl+/ — both forms open the same list, and the
      // slash branch tolerates Shift so shifted-slash layouts (German QWERTZ)
      // can reach the advertised chord (keyboard-shortcut-conventions).
      if (e.key === '?' && !e.metaKey && !e.ctrlKey && !e.altKey) {
        if (typing) return
        e.preventDefault()
        onShowRef.current()
      } else if (mod && e.key === '/') {
        if (modChordStandsDown) return
        e.preventDefault()
        onShowRef.current()
      } else if (mod && (e.key === '1' || e.key === '2')) {
        if (modChordStandsDown) return
        e.preventDefault()
        useFilterStore.getState().setFilter(e.key === '1' ? 'inbox' : 'archived')
      } else if (e.key === '/' && !e.metaKey && !e.ctrlKey && !e.altKey) {
        if (typing) return
        e.preventDefault()
        useFilterStore.getState().setFilter('archived')
        useArchiveStore.getState().setPendingSearchFocus(true)
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])
}
