type Edge = 'left' | 'right' | 'top' | 'bottom'

type Props = {
  /** Which edge of the region the handle sits on. Left/right resize width; top/bottom resize height. */
  edge: Edge
  /** Current size (width for left/right, height for top/bottom). */
  size: number
  min: number
  max: number
  /** Live size during the drag (in-memory only). */
  onResize: (size: number) => void
  /** Final size when the drag ends (persist to disk). */
  onCommit: (size: number) => void
}

const POSITION: Record<Edge, string> = {
  left: 'inset-y-0 -left-px w-1.5',
  right: 'inset-y-0 -right-px w-1.5',
  top: 'inset-x-0 -top-px h-1.5',
  bottom: 'inset-x-0 -bottom-px h-1.5',
}

/**
 * A thin drag handle pinned to a region's edge. Dragging resizes the region live
 * and commits the final size on release. It highlights on hover rather than
 * swapping the mouse cursor, per the project's no-cursor-change rule.
 */
export function ResizeHandle({ edge, size, min, max, onResize, onCommit }: Props) {
  const alongY = edge === 'top' || edge === 'bottom'
  const grows = edge === 'right' || edge === 'bottom' // moving toward this edge grows the region

  function onMouseDown(e: React.MouseEvent) {
    e.preventDefault()
    const start = alongY ? e.clientY : e.clientX
    const startSize = size
    const clamp = (s: number) => Math.max(min, Math.min(max, Math.round(s)))
    let current = startSize

    function onMove(ev: MouseEvent) {
      const pos = alongY ? ev.clientY : ev.clientX
      const delta = grows ? pos - start : start - pos
      current = clamp(startSize + delta)
      onResize(current)
    }
    function onUp() {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
      document.body.style.userSelect = ''
      onCommit(current)
    }

    document.body.style.userSelect = 'none'
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }

  return (
    <div
      onMouseDown={onMouseDown}
      role="separator"
      aria-orientation={alongY ? 'horizontal' : 'vertical'}
      className={'absolute z-10 transition-colors hover:bg-zinc-600/70 ' + POSITION[edge]}
    />
  )
}
