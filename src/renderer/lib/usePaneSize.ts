import { useEffect, useRef, useState, type RefObject } from 'react'
import { clampSplitter } from '@shared/layout'

/**
 * Derive an adjustable pane's DISPLAYED size from its persisted INTENT and the
 * live container.
 *
 * The persisted value is the intent — the size the user dragged to, bounded only
 * by the pane's own min/max. The displayed size is that intent clamped to the
 * current container (`clampSplitter`: container − siblingMin, then the pane's own
 * min/max), recomputed whenever the container resizes. A window-shrink therefore
 * narrows the *display* toward the pane minimum while the intent is untouched;
 * a window-grow returns the pane to its intent. Display-only — nothing here
 * persists (window-chrome-conventions: re-clamp on resize, never save the
 * clamped value).
 *
 * Returns a ref to attach to the flex container (the element whose extent feeds
 * the clamp) and the derived displayed size. Before the container has measured
 * (first paint), it falls back to the pane min/max clamp of the intent, so the
 * pane never renders wider than its own bounds even for a frame.
 *
 * @param intent   the persisted intent size in pixels (store-held)
 * @param vertical true for a height pane (measure clientHeight), false for width
 * @param opts     siblingMin (Σ minimums on the far side) and the pane's min/max
 */
export function usePaneSize<E extends HTMLElement = HTMLDivElement>(
  intent: number,
  vertical: boolean,
  opts: { siblingMin: number; min: number; max: number },
): { containerRef: RefObject<E | null>; displayed: number } {
  const containerRef = useRef<E | null>(null)
  const [available, setAvailable] = useState<number | null>(null)

  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    const measure = () => setAvailable(vertical ? el.clientHeight : el.clientWidth)
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    measure()
    return () => ro.disconnect()
  }, [vertical])

  const { siblingMin, min, max } = opts
  const displayed =
    available != null
      ? clampSplitter(intent, { available, siblingMin, min, max })
      : Math.max(min, Math.min(max, intent))

  return { containerRef, displayed }
}
