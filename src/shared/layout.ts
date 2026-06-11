import { z } from 'zod'

/**
 * Window/view geometry — the pane sizes the user drags. This is disposable
 * chrome, not a preference and not data: it lives in its own layout.json,
 * separate from settings (which the user edits) and session (which holds the
 * library and must never be reset). Every field self-heals — an out-of-range or
 * missing value falls back to its default rather than blocking load — because
 * losing a pane width costs the user nothing.
 *
 * Bounds live HERE only. The schema (which clamps the persisted value) and the
 * resize handles in the UI (which clamp the drag) both read LAYOUT_BOUNDS, so the
 * draggable range and the stored range can't drift apart — a mismatch would let
 * the user drag to a size the schema then silently snaps back.
 */
export const LAYOUT_BOUNDS = {
  leftPaneWidth:      { min: 200, max: 720, default: 320 },
  chaptersPaneWidth:  { min: 200, max: 720, default: 288 },
  archiveBoxesHeight: { min: 120, max: 800, default: 240 },
} as const

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
