/**
 * The slice of a fixed-height list worth rendering: the rows inside the viewport
 * plus `overscan` rows on either side. Before the list has been measured (height
 * 0), a first screenful is assumed so the list is never blank.
 */
export function visibleRowRange(
  scrollTop: number,
  viewportHeight: number,
  rowHeight: number,
  count: number,
  overscan = 8,
): { start: number; end: number } {
  const viewport = viewportHeight > 0 ? viewportHeight : rowHeight * 20
  const first = Math.floor(Math.max(0, scrollTop) / rowHeight)
  const start = Math.max(0, first - overscan)
  const end = Math.min(count, first + Math.ceil(viewport / rowHeight) + overscan)
  return { start, end: Math.max(start, end) }
}
