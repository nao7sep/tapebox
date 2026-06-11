import { useEffect, useRef } from 'react'
import { useFilterStore } from '@renderer/store/filter'
import { useArchiveStore } from '@renderer/store/archive'
import { isShortcutBlocked } from '@renderer/lib/dom'

/**
 * App-level navigation shortcuts — distinct from list/selection keys (useListKeyboard)
 * and per-tape keys (DetailPane):
 *   - ?              open the shortcuts list
 *   - ⌘/Ctrl 1 / 2   switch to Inbox / Archived
 *   - /              jump to the Archive and focus its search box
 *
 * Suppressed while typing or while a modal owns the keyboard (isShortcutBlocked).
 * The listener attaches once; store actions are read fresh via getState, and the
 * shortcuts-modal opener is read through a ref so a fresh closure each render never
 * re-binds the listener.
 */
export function useAppShortcuts(onShowShortcuts: () => void): void {
  const onShowRef = useRef(onShowShortcuts)
  onShowRef.current = onShowShortcuts

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent): void {
      if (e.defaultPrevented || isShortcutBlocked(e.target)) return
      const mod = e.metaKey || e.ctrlKey

      if (e.key === '?') {
        e.preventDefault()
        onShowRef.current()
      } else if (mod && (e.key === '1' || e.key === '2')) {
        e.preventDefault()
        useFilterStore.getState().setFilter(e.key === '1' ? 'inbox' : 'archived')
      } else if (e.key === '/' && !mod) {
        e.preventDefault()
        useFilterStore.getState().setFilter('archived')
        useArchiveStore.getState().setPendingSearchFocus(true)
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])
}
