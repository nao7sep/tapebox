import { useEffect, useRef } from 'react'
import { useBoxesStore } from '@renderer/store/boxes'
import { useArchiveStore } from '@renderer/store/archive'
import { useNavStore } from '@renderer/store/nav'
import { isShortcutBlocked } from '@renderer/lib/dom'
import { nextIndex } from '@renderer/lib/nextIndex'

/**
 * Up/Down navigation for the archive's box list, active only while the box list is
 * the keyboard panel (clicking a box makes it so). The navigable sequence is the
 * always-present Unboxed row (selectedBoxId = null) followed by the boxes in their
 * display order, so it matches what the list shows. Mounted by BoxList, which only
 * exists in the archive view; the listener binds once and reads live state via a ref.
 */
export function useBoxKeyboard(): void {
  const boxes = useBoxesStore((s) => s.boxes)
  const selectedBoxId = useArchiveStore((s) => s.selectedBoxId)
  const selectBox = useArchiveStore((s) => s.selectBox)
  const activePanel = useNavStore((s) => s.activePanel)

  const stateRef = useRef({ boxes, selectedBoxId, selectBox, activePanel })
  stateRef.current = { boxes, selectedBoxId, selectBox, activePanel }

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent): void {
      if (e.defaultPrevented || isShortcutBlocked(e.target)) return
      const { boxes, selectedBoxId, selectBox, activePanel } = stateRef.current
      if (activePanel !== 'boxes') return
      if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return
      e.preventDefault()
      // Unboxed (null) first, then boxes in display order — the order the list reads.
      const ids: (string | null)[] = [null, ...[...boxes].sort((a, b) => a.order - b.order).map((b) => b.id)]
      const idx = ids.indexOf(selectedBoxId)
      selectBox(ids[nextIndex(idx, ids.length, e.key === 'ArrowDown' ? 1 : -1)])
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])
}
