import { access, constants, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { handle } from './handle'
import * as session from '@main/store/session'
import { getSettings } from '@main/store/config'
import * as ffmpeg from '@main/services/ffmpeg'
import { getPreset } from '@shared/export-presets'
import { sanitizeFilename } from '@main/core/filename'
import { log } from '@main/io/logger'

/**
 * export:media — bring a tape out of the box, transcoding/extracting it to the
 * user's chosen format (see @shared/export-presets).
 *
 * Modes:
 *   - whole:      one file = the entire tape in the chosen format.
 *   - perChapter: one file per chapter, named via filenameTemplate. Works for
 *                 any preset — audio or video.
 *
 * Pre-flight: resolve all output paths and refuse if any already exists. Avoids
 * partially-done exports leaving the destination in a weird state.
 *
 * Template tokens for perChapter:
 *   {slug}          item.slug (falls back to sourceId/itemId)
 *   {index}         1-based chapter index
 *   {index:02}      2-digit zero-padded chapter index
 *   {chapterTitle}  chapter title, filesystem-safe (preserves Unicode,
 *                   strips only reserved characters). Empty for titles that
 *                   contain only reserved characters — the index token keeps
 *                   filenames unique.
 */

type ExportArgs = {
  itemId: string
  destinationDir: string
  mode: 'whole' | 'perChapter'
  presetId: string
  maxHeight?: number | null
  audioBitrateKbps?: number | null
  filenameTemplate?: string
}

const DEFAULT_TEMPLATE = '{slug}-{index:02}-{chapterTitle}'

export function registerExportHandlers(): void {
  handle('export:media', async (args: ExportArgs) => {
    const item = session.getItem(args.itemId)
    if (!item) throw new Error(`Item not found: ${args.itemId}`)
    if (!item.filename || !item.sidecarFilename) {
      throw new Error('Item has no media on disk yet')
    }

    const preset = getPreset(args.presetId)
    if (!preset) throw new Error(`Unknown export preset: ${args.presetId}`)

    const settings = getSettings()
    const mediaPath = join(settings.libraryDir, item.filename)
    const baseStem = item.slug ?? item.sourceId ?? item.id

    if (args.mode === 'whole') {
      const out = await ffmpeg.transcode({
        mediaPath,
        destinationDir: args.destinationDir,
        filenameStem: baseStem,
        preset,
        maxHeight: args.maxHeight,
        audioBitrateKbps: args.audioBitrateKbps,
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
      let stem = applyTemplate(template, {
        slug: baseStem,
        index: i + 1,
        chapterTitle: sanitizeFilename(c.title),
      })
      // Final scrub on the whole composed stem to defend against template
      // tokens or static template text introducing reserved characters.
      stem = sanitizeFilename(stem)
      if (!stem) {
        // chapterTitle collapsed AND template was sparse; fall back to index.
        stem = sanitizeFilename(`${baseStem}-${String(i + 1).padStart(2, '0')}`)
      }
      if (seenStems.has(stem)) {
        throw new Error(`Filename collision in export plan: "${stem}". Adjust the template.`)
      }
      seenStems.add(stem)
      planned.push({ stem, chapter: c })
    }

    // Pre-flight: no existing destination files.
    const ext = ffmpeg.resolveExt(preset, mediaPath)
    for (const p of planned) {
      const full = join(args.destinationDir, `${p.stem}.${ext}`)
      if (await fileExists(full)) {
        throw new Error(`Output already exists: ${full}`)
      }
    }

    const writtenPaths: string[] = []
    for (const p of planned) {
      const out = await ffmpeg.transcode({
        mediaPath,
        destinationDir: args.destinationDir,
        filenameStem: p.stem,
        preset,
        maxHeight: args.maxHeight,
        audioBitrateKbps: args.audioBitrateKbps,
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
}): string {
  return template
    .replace(/\{slug\}/g, ctx.slug)
    .replace(/\{index:02\}/g, String(ctx.index).padStart(2, '0'))
    .replace(/\{index\}/g, String(ctx.index))
    .replace(/\{chapterTitle\}/g, ctx.chapterTitle)
}

async function fileExists(p: string): Promise<boolean> {
  try {
    await access(p, constants.F_OK)
    return true
  } catch {
    return false
  }
}
