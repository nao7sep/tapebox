import { useCallback, useEffect } from 'react'
import { PointerSensor, useSensor, useSensors } from '@dnd-kit/core'

/**
 * Pixels the pointer must move before a press becomes a drag. Below this, a press
 * is a plain click (select a row, rename, open a menu) rather than the start of a
 * drag — shared so the inbox and archive lists can't drift to different feels.
 */
const DRAG_ACTIVATION_DISTANCE = 5

/** The drag sensors shared by the inbox and archive tape/box lists. */
export function useTapeDragSensors() {
  return useSensors(useSensor(PointerSensor, { activationConstraint: { distance: DRAG_ACTIVATION_DISTANCE } }))
}

/** Own the window-wide active-drag cursor, including context loss and unmount. */
export function useDragBodyCursor() {
  const start = useCallback(() => document.body.classList.add('dnd-dragging'), [])
  const stop = useCallback(() => document.body.classList.remove('dnd-dragging'), [])

  useEffect(() => {
    window.addEventListener('blur', stop)
    return () => {
      window.removeEventListener('blur', stop)
      stop()
    }
  }, [stop])

  return { start, stop }
}
