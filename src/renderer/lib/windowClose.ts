import { useLayoutEffect, useRef } from 'react'

type CloseState = { dirty: boolean; busy?: boolean }
const editors = new Set<() => CloseState>()
let asking = false

/** Only the main renderer owns these drafts. No state crosses a real window
 * close or restart; the window must obtain consent before destroying it. */
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
  return { dirty: states.some((state) => state.dirty), busy: states.some((state) => state.busy) }
}

// Moving focus into the discard question must not submit an inline editor.
export function isWindowClosePending(): boolean { return asking }
export function setWindowClosePending(value: boolean): void { asking = value }
