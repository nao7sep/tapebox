import { access, constants } from 'node:fs/promises'
import { extname, join } from 'node:path'
import { binaryPath } from '@main/paths'
import { log } from '@main/io/logger'
import { execCapture } from '@main/io/spawn'
import type { SidecarMedia } from '@shared/domain'
import {
  type AudioCodec,
  type ExportPreset,
  DEFAULT_AUDIO_BITRATE_KBPS,
} from '@shared/export-presets'

/**
 * ffmpeg subprocess service.
 *
 * `transcode` is the one export workhorse: it copies or re-encodes the selected
 * streams of a media file into a chosen container, optionally limited to a
 * single chapter's [start, end] range. The shape of the job is fully described
 * by an ExportPreset (see @shared/export-presets) plus two optional quality
 * knobs — audio bitrate and a video downscale cap.
 *
 * Copy/remux presets re-use the source streams bit-for-bit (fast, lossless) and
 * derive their container from the source file; encoded presets fix the
 * container and re-encode.
 */

export type TranscodeRequest = {
  mediaPath: string
  destinationDir: string
  filenameStem: string
  preset: ExportPreset
  /** Lossy-audio bitrate in kbps; ignored unless the preset re-encodes audio. */
  audioBitrateKbps?: number | null
  /** Downscale cap (px height); ignored unless the preset re-encodes video. */
  maxHeight?: number | null
  chapter?: { startSeconds: number; endSeconds: number } | null
  signal?: AbortSignal
}

// "Idle" means no stdout/stderr for this long — ffmpeg prints progress
// continuously while working, so this trips only on a genuine stall, not on a
// long-but-healthy encode.
const TRANSCODE_IDLE_TIMEOUT_MS = 30_000

// `ffmpeg -i` is a quick metadata read, but a pathological file could wedge it;
// the idle watchdog turns that into a (caught) failure instead of a hang.
const PROBE_IDLE_TIMEOUT_MS = 30_000

export async function transcode(req: TranscodeRequest): Promise<string> {
  const ext = resolveExt(req.preset, req.mediaPath)
  const outPath = join(req.destinationDir, `${req.filenameStem}.${ext}`)

  if (await exists(outPath)) {
    throw new Error(`Output already exists: ${outPath}`)
  }

  const args: string[] = ['-i', req.mediaPath]
  if (req.chapter) {
    args.push('-ss', String(req.chapter.startSeconds))
    args.push('-to', String(req.chapter.endSeconds))
  }

  if (req.preset.kind === 'audio') {
    args.push('-vn')
    appendAudioArgs(args, req.preset.acodec, req.audioBitrateKbps)
  } else {
    const { vcodec, acodec } = req.preset
    if (vcodec === 'copy') {
      args.push('-c:v', 'copy')
    } else {
      args.push('-c:v', vcodec)
      if (req.maxHeight) {
        // Cap height without ever upscaling; -2 keeps width even & proportional.
        // The comma inside min() is escaped for ffmpeg's filtergraph parser.
        args.push('-vf', `scale=-2:min(ih\\,${req.maxHeight})`)
      }
      if (vcodec === 'libx264') {
        args.push('-crf', '23', '-preset', 'medium')
      } else if (vcodec === 'libx265') {
        args.push('-crf', '28', '-preset', 'medium', '-tag:v', 'hvc1')
      } else if (vcodec === 'libvpx-vp9') {
        args.push('-crf', '32', '-b:v', '0')
      }
    }
    appendAudioArgs(args, acodec, null)
  }
  args.push(outPath)

  log.info('ffmpeg transcode', {
    outPath,
    preset: req.preset.id,
    maxHeight: req.maxHeight ?? null,
    hasChapter: !!req.chapter,
  })
  await execCapture(binaryPath('ffmpeg'), args, {
    signal: req.signal,
    idleTimeoutMs: TRANSCODE_IDLE_TIMEOUT_MS,
  })
  return outPath
}

function appendAudioArgs(args: string[], acodec: AudioCodec, bitrateKbps?: number | null): void {
  if (acodec === 'copy') {
    args.push('-c:a', 'copy')
    return
  }
  if (acodec === 'flac') {
    args.push('-c:a', 'flac')
    return
  }
  if (acodec === 'libmp3lame') {
    args.push('-c:a', 'libmp3lame')
    // VBR -q:a 2 (~190k) is the sensible MP3 default; honour an explicit bitrate.
    if (bitrateKbps) args.push('-b:a', `${bitrateKbps}k`)
    else args.push('-q:a', '2')
    return
  }
  // aac / libopus — CBR-ish target.
  args.push('-c:a', acodec, '-b:a', `${bitrateKbps ?? DEFAULT_AUDIO_BITRATE_KBPS}k`)
}

/**
 * Output container extension for a preset. Encoded presets carry a fixed `ext`;
 * copy/remux presets (ext === null) derive it from the source so the kept stream
 * lands in a compatible container.
 */
export function resolveExt(preset: ExportPreset, sourcePath: string): string {
  if (preset.ext) return preset.ext
  const src = extname(sourcePath).slice(1).toLowerCase()
  if (preset.kind === 'video') {
    // Remux: keep the source container when it's one we recognise.
    if (src === 'mp4' || src === 'webm' || src === 'mkv') return src
    return src || 'mp4'
  }
  // Audio copy: pick a container that holds the source's audio codec.
  if (src === 'mp4' || src === 'm4a' || src === 'aac') return 'm4a'
  if (src === 'webm') return 'webm'
  if (src === 'opus') return 'opus'
  if (src === 'mkv') return 'mka'
  return src || 'm4a'
}

/**
 * Read technical metadata from a media file by parsing `ffmpeg -i` output (it
 * prints stream/format info to stderr and exits non-zero because no output file
 * is given — reject:false lets us read it). Reuses the bundled ffmpeg, so no
 * separate ffprobe binary is needed. Missing fields come back null.
 */
export async function probeMedia(mediaPath: string, signal?: AbortSignal): Promise<SidecarMedia> {
  const { stderr } = await execCapture(binaryPath('ffmpeg'), ['-hide_banner', '-i', mediaPath], {
    reject: false,
    signal,
    idleTimeoutMs: PROBE_IDLE_TIMEOUT_MS,
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
