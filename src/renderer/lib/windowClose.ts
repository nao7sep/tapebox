import { useLayoutEffect, useRef } from 'react'

type CloseState = { dirty: boolean }
const editors = new Set<() => CloseState>()
let asking = false

/** Only the main renderer owns these drafts. No state crosses a quit or restart;
 * the quit must obtain consent before discarding them. Work already submitted
 * runs in main, whose quit asks about it. */
export function useWindowCloseGuard(read: () => CloseState): void {
  const latest = useRef(read)
  latest.current = read
  useLayoutEffect(() => {
    const reader = () => latest.current()
    editors.add(reader)
    return () => { editors.delete(reader) }
  }, [])
}

export function windowCloseState(): CloseState {
  const states = [...editors].map((read) => read())
  return { dirty: states.some((state) => state.dirty) }
}

// Moving focus into the discard question must not submit an inline editor.
export function isWindowClosePending(): boolean { return asking }
export function setWindowClosePending(value: boolean): void { asking = value }
