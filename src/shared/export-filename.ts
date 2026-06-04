/**
 * Per-chapter export filename templating. Shared so the main process builds the
 * real names and the export modal previews them from the same code — they can
 * never disagree.
 *
 * Tokens:
 *   {slug}          the tape's slug (or source id) — its base name
 *   {index}         1-based chapter number
 *   {index:02}      2-digit zero-padded chapter number
 *   {chapterTitle}  the chapter's title (filesystem-sanitised by the caller)
 */
export const DEFAULT_CHAPTER_TEMPLATE = '{slug}-{index:02}-{chapterTitle}'

export type ChapterNameContext = {
  slug: string
  index: number
  chapterTitle: string
}

export function applyChapterTemplate(template: string, ctx: ChapterNameContext): string {
  return template
    .replace(/\{slug\}/g, ctx.slug)
    .replace(/\{index:02\}/g, String(ctx.index).padStart(2, '0'))
    .replace(/\{index\}/g, String(ctx.index))
    .replace(/\{chapterTitle\}/g, ctx.chapterTitle)
}
