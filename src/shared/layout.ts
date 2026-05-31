import { z } from 'zod'

/**
 * Window/view geometry — the pane sizes the user drags. This is disposable
 * chrome, not a preference and not data: it lives in its own layout.json,
 * separate from settings (which the user edits) and session (which holds the
 * library and must never be reset). Every field self-heals — an out-of-range or
 * missing value falls back to its default rather than blocking load — because
 * losing a pane width costs the user nothing.
 */
export const LayoutSchema = z.object({
  leftPaneWidth: z.number().int().min(200).max(720).default(320).catch(320),
  chaptersPaneWidth: z.number().int().min(200).max(720).default(288).catch(288),
  archiveBoxesHeight: z.number().int().min(120).max(800).default(240).catch(240),
})
export type Layout = z.infer<typeof LayoutSchema>

export const defaultLayout: Layout = {
  leftPaneWidth: 320,
  chaptersPaneWidth: 288,
  archiveBoxesHeight: 240,
}
