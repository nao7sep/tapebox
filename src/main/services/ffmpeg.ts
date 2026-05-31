import { access, constants } from 'node:fs/promises'
import { extname, join } from 'node:path'
import { binaryPath } from '@main/paths'
import { log } from '@main/io/logger'
import { execCapture } from '@main/io/spawn'
import type { SidecarMedia } from '@shared/domain'

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
  signal?: AbortSignal
}

const EXTRACT_IDLE_TIMEOUT_MS = 30_000

export async function extractAudio(opts: ExtractOptions): Promise<string> {
  const ext = audioExtension(opts.codec, opts.mediaPath)
  const outPath = join(opts.destinationDir, `${opts.filenameStem}.${ext}`)

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
  await execCapture(binaryPath('ffmpeg'), args, {
    signal: opts.signal,
    idleTimeoutMs: EXTRACT_IDLE_TIMEOUT_MS,
  })
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

/**
 * Read technical metadata from a media file by parsing `ffmpeg -i` output (it
 * prints stream/format info to stderr and exits non-zero because no output file
 * is given — reject:false lets us read it). Reuses the bundled ffmpeg, so no
 * separate ffprobe binary is needed. Missing fields come back null.
 */
export async function probeMedia(mediaPath: string): Promise<SidecarMedia> {
  const { stderr } = await execCapture(binaryPath('ffmpeg'), ['-hide_banner', '-i', mediaPath], {
    reject: false,
  })
  return parseFfmpegInfo(stderr)
}

function parseFfmpegInfo(text: string): SidecarMedia {
  const info: SidecarMedia = {
    width: null,
    height: null,
    fps: null,
    vcodec: null,
    acodec: null,
    durationSeconds: null,
    bitrateKbps: null,
  }

  const dur = text.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/)
  if (dur) info.durationSeconds = Number(dur[1]) * 3600 + Number(dur[2]) * 60 + parseFloat(dur[3]!)

  const bitrate = text.match(/bitrate:\s*(\d+)\s*kb\/s/)
  if (bitrate) info.bitrateKbps = Number(bitrate[1])

  // e.g. "Stream #0:0(und): Video: h264 (High) (avc1 / ...), yuv420p, 640x360 [SAR ...], 30 fps"
  const video = text.match(/Video:\s*(\w+)[^\n]*?\b(\d{2,5})x(\d{2,5})\b/)
  if (video) {
    info.vcodec = video[1]!
    info.width = Number(video[2])
    info.height = Number(video[3])
  }
  const fps = text.match(/\b(\d+(?:\.\d+)?)\s+fps\b/)
  if (fps) info.fps = parseFloat(fps[1]!)

  const audio = text.match(/Audio:\s*(\w+)/)
  if (audio) info.acodec = audio[1]!

  return info
}

async function exists(p: string): Promise<boolean> {
  try {
    await access(p, constants.F_OK)
    return true
  } catch {
    return false
  }
}
