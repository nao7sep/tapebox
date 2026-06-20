import { z } from 'zod'

/**
 * Window/view geometry — the pane sizes the user drags. This is disposable
 * chrome, not a preference and not data: it lives in its own layout.json,
 * separate from settings (which the user edits) and session (which holds the
 * library and must never be reset). Every field self-heals — an out-of-range or
 * missing value falls back to its default rather than blocking load — because
 * losing a pane width costs the user nothing.
 *
 * Bounds live HERE only. The schema (which clamps the persisted value), the
 * resize handles in the UI (which clamp the drag), AND the window's own minimum
 * size all read from this file, so the draggable range, the stored range, and the
 * OS-enforced floor can't drift apart — a mismatch would let the user drag to a
 * size the schema then silently snaps back, or shrink the window until a pane is
 * squeezed out. The window minimum is DERIVED below (window-chrome-conventions:
 * window min = Σ pane mins + chrome), never hand-typed.
 */
export const LAYOUT_BOUNDS = {
  leftPaneWidth:      { min: 200, max: 720, default: 320 },
  chaptersPaneWidth:  { min: 200, max: 720, default: 288 },
  archiveBoxesHeight: { min: 120, max: 800, default: 240 },
} as const

/**
 * The archived view's lower tape-list minimum height — the sibling below the
 * draggable boxes list within the left pane. Reserved so a tall persisted (or
 * dragged) boxes height can never swallow the lower list and shove its separator
 * off-screen: the boxes ceiling is the live pane height minus the search box minus
 * this. Replaces the old hand-typed RESERVE_PX cap with a named minimum the clamp
 * derives from.
 */
export const archiveLowerListMin = { min: 120 } as const

/**
 * The archived view's search box height (its px-3 py-2 wrapper around the
 * py-1.5 text-sm input). Fixed chrome above the boxes list, reserved alongside
 * the lower-list minimum when clamping the boxes height.
 */
export const ARCHIVE_SEARCH_BOX_HEIGHT = 52

/**
 * The right detail column's minimum width. Unlike the panes above it is not
 * user-draggable (it is the `flex-1` fill), so it carries no max/default — only
 * the smallest width at which its content stays usable: the wrapping action-button
 * row reading on one or two lines beside the 200px-min media preview box. Below
 * this the buttons stack into an unusable tower and the preview is pinched. It is
 * the third horizontal pane minimum and so feeds WINDOW_MIN_WIDTH.
 */
export const detailPaneWidth = { min: 360 } as const

/**
 * Fixed chrome heights, in CSS pixels, measured from the rendered classes so the
 * derived WINDOW_MIN_HEIGHT covers the bars that are reserved before the content
 * area (window-chrome-conventions: fixed chrome is reserved first and counts
 * toward the window minimum). Kept deliberately in sync with the markup:
 *
 *   HEADER_HEIGHT     header in App.tsx: py-2.5 (20px) + 1px border-b, around the
 *                     tallest control, the URL input (text-sm 22px line + py-2
 *                     16px + 2px border = 40px) → 61px.
 *   STATUS_BAR_HEIGHT footer in StatusBar.tsx: py-1.5 (12px) + 1px border-t,
 *                     around text-xs content (18px line) → 31px.
 */
export const HEADER_HEIGHT = 61
export const STATUS_BAR_HEIGHT = 31

/**
 * The smallest height the resizable content row (between header and status bar)
 * stays usable: the detail pane's 200px-min media preview box plus its title
 * header and the wrapping action-button row. The binding vertical pane minimum.
 */
export const CONTENT_MIN_HEIGHT = 360

/**
 * Vertical pane dividers counted into the width minimum: the left pane's border-r
 * and the chapters pane's border-l, 1px each.
 */
export const PANE_BORDERS = 2

/**
 * Window minimums DERIVED from the pane minimums + fixed chrome — the single
 * source of truth consumed by the main process so the OS floor can never disagree
 * with the layout. Width reserves all three horizontal panes plus their dividers;
 * height reserves the header and status bars (the binding fixed chrome) plus the
 * content row's minimum.
 */
export const WINDOW_MIN_WIDTH =
  LAYOUT_BOUNDS.leftPaneWidth.min +
  detailPaneWidth.min +
  LAYOUT_BOUNDS.chaptersPaneWidth.min +
  PANE_BORDERS
export const WINDOW_MIN_HEIGHT = HEADER_HEIGHT + STATUS_BAR_HEIGHT + CONTENT_MIN_HEIGHT

/**
 * Clamp a splitter drag so a widened pane can never push a sibling below its
 * minimum. The geometric upper bound is the live container size minus the summed
 * minimums of the panes on the other side of the handle; the pane's own
 * configured min/max still apply. Pure so it is unit-testable and shared by every
 * resize handle (window-chrome-conventions: splitters clamped against the
 * minimums). `available` is the live container extent (width for a vertical
 * splitter, height for a horizontal one); `siblingMin` is Σ minimums on the far
 * side; `min`/`max` are the dragged pane's own bounds.
 */
export function clampSplitter(
  desired: number,
  opts: { available: number; siblingMin: number; min: number; max: number },
): number {
  const { available, siblingMin, min, max } = opts
  // The most this pane may take and still leave every sibling its minimum.
  const room = available - siblingMin
  // Never let the room ceiling fall below the pane's own min (a too-small window
  // is held by WINDOW_MIN_* / the schema floor; the pane still reports its min).
  const ceiling = Math.max(min, Math.min(max, room))
  return Math.max(min, Math.min(ceiling, Math.round(desired)))
}

/** A self-healing integer dimension bounded by, and defaulting to, the given range. */
const dim = (b: { min: number; max: number; default: number }) =>
  z.number().int().min(b.min).max(b.max).default(b.default).catch(b.default)

export const LayoutSchema = z.object({
  leftPaneWidth: dim(LAYOUT_BOUNDS.leftPaneWidth),
  chaptersPaneWidth: dim(LAYOUT_BOUNDS.chaptersPaneWidth),
  archiveBoxesHeight: dim(LAYOUT_BOUNDS.archiveBoxesHeight),
})
export type Layout = z.infer<typeof LayoutSchema>

export const defaultLayout: Layout = {
  leftPaneWidth: LAYOUT_BOUNDS.leftPaneWidth.default,
  chaptersPaneWidth: LAYOUT_BOUNDS.chaptersPaneWidth.default,
  archiveBoxesHeight: LAYOUT_BOUNDS.archiveBoxesHeight.default,
}
