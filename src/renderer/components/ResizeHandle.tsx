type Props = {
  /** Which edge of the pane the handle sits on. 'right' for a left pane, 'left' for a right pane. */
  edge: 'left' | 'right'
  width: number
  min: number
  max: number
  /** Live width during the drag (in-memory only). */
  onResize: (width: number) => void
  /** Final width when the drag ends (persist to disk). */
  onCommit: (width: number) => void
}

/**
 * A thin vertical drag handle pinned to a side pane's edge. Dragging resizes the
 * pane live and commits the final width on release. It highlights on hover rather
 * than swapping the mouse cursor, per the project's no-cursor-change rule.
 */
export function ResizeHandle({ edge, width, min, max, onResize, onCommit }: Props) {
  function onMouseDown(e: React.MouseEvent) {
    e.preventDefault()
    const startX = e.clientX
    const startW = width
    const clamp = (w: number) => Math.max(min, Math.min(max, Math.round(w)))
    let current = startW

    function onMove(ev: MouseEvent) {
      const delta = edge === 'right' ? ev.clientX - startX : startX - ev.clientX
      current = clamp(startW + delta)
      onResize(current)
    }
    function onUp() {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
      document.body.style.userSelect = ''
      onCommit(current)
    }

    // Suppress text selection while dragging across the window.
    document.body.style.userSelect = 'none'
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }

  return (
    <div
      onMouseDown={onMouseDown}
      role="separator"
      aria-orientation="vertical"
      className={
        'absolute inset-y-0 z-10 w-1.5 transition-colors hover:bg-zinc-600/70 ' +
        (edge === 'right' ? '-right-px' : '-left-px')
      }
    />
  )
}
