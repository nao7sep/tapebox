import { access, constants, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { handle } from './handle'
import * as session from '@main/store/session'
import { getSettings } from '@main/store/config'
import * as ffmpeg from '@main/services/ffmpeg'
import { normalizeSlug } from '@main/core/slug'
import { log } from '@main/io/logger'

/**
 * export:audio — bring tape out of the box, copy tracks to the user's choice.
 *
 * Modes:
 *   - whole:      one file = the entire audio track.
 *   - perChapter: one file per chapter, named via filenameTemplate.
 *
 * Pre-flight: resolve all output paths and refuse if any already exists. Avoids
 * partially-done exports leaving the destination in a weird state.
 *
 * Template tokens for perChapter:
 *   {slug}          item.slug (falls back to sourceId/itemId)
 *   {index}         1-based chapter index
 *   {index:02}      2-digit zero-padded chapter index
 *   {chapterTitle}  chapter title, slug-normalized
 *   {chapterTitleRaw}  chapter title, raw (use carefully — may contain weird chars)
 */

type ExportArgs = {
  itemId: string
  destinationDir: string
  mode: 'whole' | 'perChapter'
  codec: 'copy' | 'mp3' | 'flac'
  filenameTemplate?: string
}

const DEFAULT_TEMPLATE = '{slug}-{index:02}-{chapterTitle}'

export function registerExportHandlers(): void {
  handle('export:audio', async (args: ExportArgs) => {
    const item = session.getItem(args.itemId)
    if (!item) throw new Error(`Item not found: ${args.itemId}`)
    if (!item.filename || !item.sidecarFilename) {
      throw new Error('Item has no media on disk yet')
    }

    const settings = getSettings()
    const mediaPath = join(settings.libraryDir, item.filename)
    const baseStem = item.slug ?? item.sourceId ?? item.id

    if (args.mode === 'whole') {
      const out = await ffmpeg.extractAudio({
        mediaPath,
        destinationDir: args.destinationDir,
        filenameStem: baseStem,
        codec: args.codec,
        chapter: null,
      })
      log.info('export:whole done', { itemId: args.itemId, out })
      return { writtenPaths: [out] }
    }

    // perChapter
    const sidecarText = await readFile(join(settings.libraryDir, item.sidecarFilename), 'utf8')
    const sidecar = JSON.parse(sidecarText) as {
      chapters?: Array<{ start_time: number; end_time: number; title: string }>
    }
    const chapters = Array.isArray(sidecar.chapters) ? sidecar.chapters : []
    if (chapters.length === 0) {
      throw new Error('This item has no chapter markers to split.')
    }

    const template = args.filenameTemplate || DEFAULT_TEMPLATE
    const planned: Array<{ stem: string; chapter: typeof chapters[number] }> = []
    const seenStems = new Set<string>()

    for (let i = 0; i < chapters.length; i++) {
      const c = chapters[i]!
      const stem = applyTemplate(template, {
        slug: baseStem,
        index: i + 1,
        chapterTitle: normalizeSlug(c.title),
        chapterTitleRaw: c.title,
      })
      if (seenStems.has(stem)) {
        throw new Error(`Filename collision in export plan: "${stem}". Adjust the template.`)
      }
      seenStems.add(stem)
      planned.push({ stem, chapter: c })
    }

    // Pre-flight: no existing destination files.
    for (const p of planned) {
      const ext = ffmpeg.audioExtension(args.codec, mediaPath)
      const full = join(args.destinationDir, `${p.stem}.${ext}`)
      if (await fileExists(full)) {
        throw new Error(`Output already exists: ${full}`)
      }
    }

    const writtenPaths: string[] = []
    for (const p of planned) {
      const out = await ffmpeg.extractAudio({
        mediaPath,
        destinationDir: args.destinationDir,
        filenameStem: p.stem,
        codec: args.codec,
        chapter: { startSeconds: p.chapter.start_time, endSeconds: p.chapter.end_time },
      })
      writtenPaths.push(out)
    }
    log.info('export:perChapter done', { itemId: args.itemId, count: writtenPaths.length })
    return { writtenPaths }
  })
}

function applyTemplate(template: string, ctx: {
  slug: string
  index: number
  chapterTitle: string
  chapterTitleRaw: string
}): string {
  return template
    .replace(/\{slug\}/g, ctx.slug)
    .replace(/\{index:02\}/g, String(ctx.index).padStart(2, '0'))
    .replace(/\{index\}/g, String(ctx.index))
    .replace(/\{chapterTitle\}/g, ctx.chapterTitle)
    .replace(/\{chapterTitleRaw\}/g, ctx.chapterTitleRaw)
}

async function fileExists(p: string): Promise<boolean> {
  try {
    await access(p, constants.F_OK)
    return true
  } catch {
    return false
  }
}
