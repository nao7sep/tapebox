import { useRef } from 'react'
import { clampSplitter } from '@shared/layout'

type Edge = 'left' | 'right' | 'top' | 'bottom'

type Props = {
  /** Which edge of the region the handle sits on. Left/right resize width; top/bottom resize height. */
  edge: Edge
  /** Current size (width for left/right, height for top/bottom). */
  size: number
  min: number
  max: number
  /**
   * Σ minimums of the panes on the OTHER side of this handle within the same
   * container. The drag is clamped so the dragged pane never takes so much that a
   * sibling would fall below its minimum: the live ceiling is
   * `container − siblingMin` (window-chrome-conventions: splitters clamped against
   * the minimums). Defaults to 0 — a lone pane with no siblings to starve.
   */
  siblingMin?: number
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
export function ResizeHandle({ edge, size, min, max, siblingMin = 0, onResize, onCommit }: Props) {
  const alongY = edge === 'top' || edge === 'bottom'
  const grows = edge === 'right' || edge === 'bottom' // moving toward this edge grows the region
  const handleRef = useRef<HTMLDivElement>(null)

  function onMouseDown(e: React.MouseEvent) {
    e.preventDefault()
    const start = alongY ? e.clientY : e.clientX
    const startSize = size
    // The live container extent, captured at drag start: the flex container that
    // holds this pane and its siblings. The dragged pane lives inside the pane
    // element, which is the handle's offsetParent (positioned ancestor); its
    // parent is the container. Measuring live (not from a prop) means the clamp
    // re-derives the ceiling against the current window size on every drag.
    const container = handleRef.current?.offsetParent?.parentElement ?? null
    const available = container ? (alongY ? container.clientHeight : container.clientWidth) : Infinity
    const clamp = (s: number) => clampSplitter(s, { available, siblingMin, min, max })
    let current = clamp(startSize)

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
      ref={handleRef}
      onMouseDown={onMouseDown}
      role="separator"
      aria-orientation={alongY ? 'horizontal' : 'vertical'}
      className={'absolute z-10 transition-colors hover:bg-zinc-600/70 ' + POSITION[edge]}
    />
  )
}
