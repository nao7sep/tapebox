import { useRef } from 'react'

type Edge = 'left' | 'right' | 'top' | 'bottom'

type Props = {
  /** Which edge of the region the handle sits on. Left/right resize width; top/bottom resize height. */
  edge: Edge
  /**
   * The pane's current DISPLAYED size (width for left/right, height for
   * top/bottom) — the value the consumer already derived by clamping the stored
   * intent to the live container. The drag starts from here, so the handle picks
   * up exactly where the pane is shown.
   */
  size: number
  min: number
  max: number
  /** Live intent during the drag (in-memory only — the consumer re-derives the display). */
  onResize: (size: number) => void
  /** Final intent when the drag ends (persist to disk). */
  onCommit: (size: number) => void
}

const POSITION: Record<Edge, string> = {
  left: 'inset-y-0 -left-px w-1.5',
  right: 'inset-y-0 -right-px w-1.5',
  top: 'inset-x-0 -top-px h-1.5',
  bottom: 'inset-x-0 -bottom-px h-1.5',
}

/**
 * A thin drag handle pinned to a region's edge. A drag sets the pane's INTENT —
 * the size the user is reaching for, bounded only by the pane's own min/max, NOT
 * by the live container. The consumer persists this intent and separately derives
 * the displayed size by clamping it to the container (so a too-small window
 * narrows the *display* while the intent — and thus the size the pane returns to
 * when the window grows — is preserved). The handle therefore does no
 * container-aware clamping itself; that lives in the consumer's derivation
 * (clampSplitter), the single place the intent meets the live geometry.
 *
 * It highlights on hover and shows the axis-matched resize cursor (col-resize on
 * a left/right edge, row-resize on a top/bottom edge), per the cursor conventions'
 * divider rule.
 */
export function ResizeHandle({ edge, size, min, max, onResize, onCommit }: Props) {
  const alongY = edge === 'top' || edge === 'bottom'
  const grows = edge === 'right' || edge === 'bottom' // moving toward this edge grows the region
  const handleRef = useRef<HTMLDivElement>(null)

  function onMouseDown(e: React.MouseEvent) {
    e.preventDefault()
    const start = alongY ? e.clientY : e.clientX
    const startSize = size
    // The intent is bounded by the pane's own min/max only; the consumer clamps it
    // to the live container when it derives the displayed size.
    const toIntent = (s: number) => Math.max(min, Math.min(max, Math.round(s)))
    let current = toIntent(startSize)

    function onMove(ev: MouseEvent) {
      const pos = alongY ? ev.clientY : ev.clientX
      const delta = grows ? pos - start : start - pos
      current = toIntent(startSize + delta)
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
      className={
        'absolute z-10 transition-colors hover:bg-zinc-600/70 ' +
        (alongY ? 'cursor-row-resize ' : 'cursor-col-resize ') +
        POSITION[edge]
      }
    />
  )
}
