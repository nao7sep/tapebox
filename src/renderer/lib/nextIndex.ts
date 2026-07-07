/**
 * Next index when moving a selection by `dir` (-1 up, +1 down) through a list of
 * `length` items, clamped to the ends — no wrap-around. `current` is the current
 * index, or -1 when nothing is selected yet: then Down lands on the first item and
 * Up on the last, so the first arrow press always enters the list. Returns -1 for
 * an empty list. Pure; shared by the video, chapter, and box keyboard handlers.
 */
export function nextIndex(current: number, length: number, dir: -1 | 1): number {
  if (length === 0) return -1
  if (current === -1) return dir === 1 ? 0 : length - 1
  return Math.min(Math.max(current + dir, 0), length - 1)
}
