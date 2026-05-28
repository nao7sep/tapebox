import { access, constants } from 'node:fs/promises'
import { extname, join } from 'node:path'
import { execa } from 'execa'
import { binaryPath } from '@main/paths'
import { log } from '@main/io/logger'

/**
 * ffmpeg subprocess service.
 *
 * Two operations matter for now:
 *   - extractWholeAudio: pulls the audio track from a media file.
 *   - extractChapterAudio: same, but limited to one chapter's [start, end] range.
 *
 * codec 'copy' avoids re-encoding — bit-perfect, fast — when the source codec
 * is compatible with the chosen container. For YouTube's typical AAC-in-MP4
 * output, copy lands as .m4a. If the user picks 'mp3'/'flac' we re-encode.
 */

export type Codec = 'copy' | 'mp3' | 'flac'

export type ExtractOptions = {
  mediaPath: string
  destinationDir: string
  filenameStem: string
  codec: Codec
  chapter?: { startSeconds: number; endSeconds: number } | null
}

export async function extractAudio(opts: ExtractOptions): Promise<string> {
  const ext = audioExtension(opts.codec, opts.mediaPath)
  const outPath = join(opts.destinationDir, `${opts.filenameStem}.${ext}`)

  // Refuse to overwrite. Caller does pre-flight checks; this is belt-and-suspenders.
  if (await exists(outPath)) {
    throw new Error(`Output already exists: ${outPath}`)
  }

  const args: string[] = ['-i', opts.mediaPath]
  if (opts.chapter) {
    args.push('-ss', String(opts.chapter.startSeconds))
    args.push('-to', String(opts.chapter.endSeconds))
  }
  args.push('-vn')
  if (opts.codec === 'copy') {
    args.push('-c:a', 'copy')
  } else if (opts.codec === 'mp3') {
    args.push('-c:a', 'libmp3lame', '-q:a', '2')
  } else if (opts.codec === 'flac') {
    args.push('-c:a', 'flac')
  }
  args.push(outPath)

  log.info('ffmpeg extract', { outPath, codec: opts.codec, hasChapter: !!opts.chapter })
  try {
    await execa(binaryPath('ffmpeg'), args, { reject: true })
  } catch (err) {
    throw new Error(`ffmpeg failed: ${String(err)}`)
  }
  return outPath
}

export function audioExtension(codec: Codec, sourcePath: string): string {
  if (codec === 'mp3') return 'mp3'
  if (codec === 'flac') return 'flac'
  // codec === 'copy' — choose a container compatible with the source codec.
  const ext = extname(sourcePath).slice(1).toLowerCase()
  if (ext === 'mp4' || ext === 'm4a' || ext === 'aac') return 'm4a'
  if (ext === 'webm') return 'webm'
  if (ext === 'opus') return 'opus'
  if (ext === 'mkv') return 'mka'
  return ext || 'm4a'
}

async function exists(p: string): Promise<boolean> {
  try {
    await access(p, constants.F_OK)
    return true
  } catch {
    return false
  }
}
