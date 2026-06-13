import { useEffect, useRef, type RefObject } from 'react'
import { isEditableElement } from '@renderer/lib/dom'

/**
 * Ref for a row whose selection should track keyboard focus only while its list is
 * the *active* one. The selected row of the active panel pulls focus (so the focus
 * ring follows the arrow keys), while a selected row in an inactive panel keeps its
 * selection styling but never steals focus — the basis for "a selection stays
 * visible even when its pane isn't the one being driven."
 *
 * Never yanks focus out of a text field: this effect also runs on mount, and a list
 * can mount while the user is typing elsewhere (e.g. the archive search box).
 * Scrolling the selected row into view is always safe, active or not.
 *
 * Shared by the video rows (TapeRow) and the chapter rows.
 */
export function useRovingFocus<T extends HTMLElement>(
  active: boolean,
  selected: boolean,
): RefObject<T | null> {
  const ref = useRef<T | null>(null)
  useEffect(() => {
    if (!selected) return
    if (active && !isEditableElement(document.activeElement)) {
      ref.current?.focus({ preventScroll: true })
    }
    ref.current?.scrollIntoView({ block: 'nearest' })
  }, [active, selected])
  return ref
}
