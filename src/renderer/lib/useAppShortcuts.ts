import { useEffect, useRef } from 'react'
import { useFilterStore } from '@renderer/store/filter'
import { useArchiveStore } from '@renderer/store/archive'
import { isShortcutBlocked } from '@renderer/lib/dom'
import { hasMod } from '@renderer/lib/shortcuts'

/**
 * App-level navigation shortcuts — distinct from the per-list keys (useListboxKeyboard)
 * and per-tape keys (DetailPane):
 *   - ? or ⌘/Ctrl /  open the shortcuts list
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
      const mod = hasMod(e)

      // "?" first, then Cmd/Ctrl+/ — both forms open the same list, and the
      // slash branch tolerates Shift so shifted-slash layouts (German QWERTZ)
      // can reach the advertised chord (keyboard-shortcut-conventions).
      if (e.key === '?' && !e.metaKey && !e.ctrlKey && !e.altKey) {
        e.preventDefault()
        onShowRef.current()
      } else if (mod && e.key === '/') {
        e.preventDefault()
        onShowRef.current()
      } else if (mod && (e.key === '1' || e.key === '2')) {
        e.preventDefault()
        useFilterStore.getState().setFilter(e.key === '1' ? 'inbox' : 'archived')
      } else if (e.key === '/' && !e.metaKey && !e.ctrlKey && !e.altKey) {
        // Bare printable key: raw flags, not !hasMod — the predicate's Alt
        // exclusion would make "no command modifier" read true under AltGr.
        e.preventDefault()
        useFilterStore.getState().setFilter('archived')
        useArchiveStore.getState().setPendingSearchFocus(true)
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])
}
