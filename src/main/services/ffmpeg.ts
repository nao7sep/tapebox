import { access, constants, rename, unlink } from 'node:fs/promises'
import { basename, extname, join, resolve } from 'node:path'
import { binaryPath } from '@main/paths'
import { log } from '@main/io/logger'
import { execCapture, makeLineBuffer, spawnStreaming, SubprocessError, waitForExit } from '@main/io/spawn'
import type { SidecarMedia } from '@shared/domain'
import {
  type AudioChannels,
  type AudioCodec,
  type EncodeSpeed,
  type ExportPreset,
  type VideoCodec,
  type VideoQuality,
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
  /** Output channel layout; ignored unless the preset re-encodes audio. */
  audioChannels?: AudioChannels | null
  /** Loudness-normalise the audio (loudnorm); ignored unless audio is re-encoded. */
  normalizeAudio?: boolean
  /** Downscale cap (px height); ignored unless the preset re-encodes video. */
  maxHeight?: number | null
  /** Quality tier (→ CRF); ignored unless the preset re-encodes video. */
  videoQuality?: VideoQuality | null
  /** Encoder speed tier (→ -preset); ignored unless the preset re-encodes video. */
  encodeSpeed?: EncodeSpeed | null
  /** Frame-rate cap; ignored unless the preset re-encodes video. */
  fpsCap?: number | null
  chapter?: { startSeconds: number; endSeconds: number } | null
  /** Each ffmpeg output line, streamed live (its progress redraws included). */
  onLog?: (line: string) => void
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
    appendAudioArgs(args, req.preset.acodec, req)
  } else {
    const { vcodec, acodec } = req.preset
    if (vcodec === 'copy') {
      args.push('-c:v', 'copy')
    } else {
      args.push('-c:v', vcodec)
      appendVideoFilters(args, req)
      appendVideoQualityArgs(args, vcodec, req.videoQuality, req.encodeSpeed)
    }
    appendAudioArgs(args, acodec, req)
  }
  args.push(outPath)

  log.info('ffmpeg transcode', {
    outPath,
    preset: req.preset.id,
    maxHeight: req.maxHeight ?? null,
    hasChapter: !!req.chapter,
  })

  // Stream rather than buffer so the caller can show live activity. ffmpeg's
  // progress redraws use carriage returns, so split on those too.
  const child = spawnStreaming(binaryPath('ffmpeg'), args, {
    signal: req.signal,
    idleTimeoutMs: TRANSCODE_IDLE_TIMEOUT_MS,
  })
  const recentLines: string[] = []
  const lineBuffer = makeLineBuffer((line) => {
    if (!line.trim()) return
    recentLines.push(line)
    if (recentLines.length > 60) recentLines.shift()
    req.onLog?.(line)
  }, { splitOnCR: true })
  child.stdout.on('data', lineBuffer.feed)
  child.stderr.on('data', lineBuffer.feed)

  try {
    await waitForExit(child, { command: 'ffmpeg transcode' })
  } catch (err) {
    lineBuffer.flush()
    // ffmpeg's own output is the real error text; attach it so the failure isn't
    // just an exit code (mirrors the yt-dlp download path).
    if (err instanceof SubprocessError) {
      throw new SubprocessError(err.command, err.exitCode, recentLines.join('\n').trim() || err.stderr)
    }
    throw err
  } finally {
    lineBuffer.flush()
  }
  return outPath
}

// Thumbnail encoding — fixed, not user-configurable. Every poster image passes
// through saveThumbnailJpeg, so these literals are the one place the library's
// thumbnail format is decided. Values target a clean preview at modest size, not
// archival fidelity: a poster is only ever shown letterboxed in the player.
const THUMBNAIL_JPEG_QSCALE = 3      // ffmpeg mjpeg -q:v: 2 (best) … 31 (worst)
const THUMBNAIL_MAX_EDGE_PX = 1280   // cap the longer side; never upscales smaller art
const THUMBNAIL_IDLE_TIMEOUT_MS = 30_000

/**
 * The single gate through which every thumbnail is persisted. Transcodes a raw
 * source image (any format yt-dlp fetched) to a normalized JPEG at
 * {destDir}/{stem}.jpg and returns that basename — so the rest of the app never
 * has to wonder what format or quality a thumbnail is.
 *
 * Writes through a staging file then renames into place, which lets the source
 * legitimately BE {stem}.jpg (a re-encode in place); the source is removed
 * afterwards unless it already was the destination. Throws on failure — the
 * caller decides whether a missing poster is fatal (it isn't) or worth surfacing.
 */
export async function saveThumbnailJpeg(
  sourceImagePath: string,
  destDir: string,
  stem: string,
  signal?: AbortSignal,
): Promise<string> {
  const finalName = `${stem}.jpg`
  const finalPath = join(destDir, finalName)
  // Staging must keep a real .jpg extension: ffmpeg chooses the output muxer from
  // the extension, and a bare `.staging` suffix leaves it "unable to choose an
  // output format". It's renamed onto finalPath once written; findThumbnail
  // ignores it because its stem ("{stem}.staging") differs.
  const stagePath = join(destDir, `${stem}.staging.jpg`)

  const args = [
    '-hide_banner',
    '-i', sourceImagePath,
    // Fit within a MAX×MAX box preserving aspect, only ever shrinking: the box is
    // clamped to the source's own size, so a thumbnail smaller than the cap is
    // passed through untouched rather than upscaled. Commas inside the expressions
    // are arguments to min(), not filter separators, so no escaping is needed in
    // an argv array (unlike a shell).
    '-vf', `scale='min(${THUMBNAIL_MAX_EDGE_PX},iw)':'min(${THUMBNAIL_MAX_EDGE_PX},ih)':force_original_aspect_ratio=decrease`,
    '-q:v', String(THUMBNAIL_JPEG_QSCALE),
    // Write exactly one image to the fixed filename: the image2 muxer otherwise
    // expects a numbered sequence pattern (%03d) and warns without these.
    '-frames:v', '1',
    '-update', '1',
    '-y', stagePath,
  ]

  const child = spawnStreaming(binaryPath('ffmpeg'), args, { signal, idleTimeoutMs: THUMBNAIL_IDLE_TIMEOUT_MS })
  const recentLines: string[] = []
  const lineBuffer = makeLineBuffer((line) => {
    if (!line.trim()) return
    recentLines.push(line)
    if (recentLines.length > 40) recentLines.shift()
  }, { splitOnCR: true })
  child.stdout.on('data', lineBuffer.feed)
  child.stderr.on('data', lineBuffer.feed)

  try {
    await waitForExit(child, { command: 'ffmpeg thumbnail' })
  } catch (err) {
    lineBuffer.flush()
    await unlink(stagePath).catch(() => {}) // a partial staging file may have landed
    if (err instanceof SubprocessError) {
      throw new SubprocessError(err.command, err.exitCode, recentLines.join('\n').trim() || err.stderr)
    }
    throw err
  } finally {
    lineBuffer.flush()
  }

  await rename(stagePath, finalPath)
  // The source is consumed. Drop it unless it WAS the destination (a jpg→jpg
  // re-encode), in which case the rename above already replaced it.
  if (resolve(sourceImagePath) !== resolve(finalPath)) await unlink(sourceImagePath).catch(() => {})
  log.info('thumbnail saved', { stem, source: basename(sourceImagePath) })
  return finalName
}

/** Video filter chain: downscale and/or frame-rate cap, joined into one -vf. */
function appendVideoFilters(args: string[], req: TranscodeRequest): void {
  const filters: string[] = []
  if (req.maxHeight) {
    // Cap height without ever upscaling; -2 keeps width even & proportional.
    // The comma inside min() is escaped for ffmpeg's filtergraph parser.
    filters.push(`scale=-2:min(ih\\,${req.maxHeight})`)
  }
  if (req.fpsCap) filters.push(`fps=${req.fpsCap}`)
  if (filters.length > 0) args.push('-vf', filters.join(','))
}

// Base CRF per codec at the "balanced" tier; the quality tier shifts it (a lower
// CRF is higher quality / larger). x264/x265 take -preset for speed; VP9 maps
// the same tiers to -cpu-used and always runs constant-quality (-b:v 0).
const CRF_BASE: Record<Exclude<VideoCodec, 'copy'>, number> = {
  libx264: 23,
  libx265: 28,
  'libvpx-vp9': 32,
}
const QUALITY_DELTA: Record<VideoQuality, number> = { higher: -4, balanced: 0, smaller: 4 }
const X264_PRESET: Record<EncodeSpeed, string> = { fast: 'fast', medium: 'medium', slow: 'slow' }
const VP9_CPU_USED: Record<EncodeSpeed, string> = { fast: '4', medium: '2', slow: '1' }

function appendVideoQualityArgs(
  args: string[],
  vcodec: Exclude<VideoCodec, 'copy'>,
  quality: VideoQuality | null | undefined,
  speed: EncodeSpeed | null | undefined,
): void {
  const crf = CRF_BASE[vcodec] + QUALITY_DELTA[quality ?? 'balanced']
  const sp = speed ?? 'medium'
  if (vcodec === 'libvpx-vp9') {
    args.push('-crf', String(crf), '-b:v', '0', '-cpu-used', VP9_CPU_USED[sp])
    return
  }
  args.push('-crf', String(crf), '-preset', X264_PRESET[sp])
  if (vcodec === 'libx265') args.push('-tag:v', 'hvc1')
}

function appendAudioArgs(args: string[], acodec: AudioCodec, req: TranscodeRequest): void {
  if (acodec === 'copy') {
    args.push('-c:a', 'copy')
    return
  }

  // Channel layout and loudness apply to any re-encoded audio stream.
  if (req.audioChannels === 'mono') args.push('-ac', '1')
  else if (req.audioChannels === 'stereo') args.push('-ac', '2')
  if (req.normalizeAudio) args.push('-af', 'loudnorm')

  if (acodec === 'flac') {
    args.push('-c:a', 'flac')
    return
  }
  if (acodec === 'libmp3lame') {
    args.push('-c:a', 'libmp3lame')
    // VBR -q:a 2 (~190k) is the sensible MP3 default; honour an explicit bitrate.
    if (req.audioBitrateKbps) args.push('-b:a', `${req.audioBitrateKbps}k`)
    else args.push('-q:a', '2')
    return
  }
  // aac / libopus — CBR-ish target.
  args.push('-c:a', acodec, '-b:a', `${req.audioBitrateKbps ?? DEFAULT_AUDIO_BITRATE_KBPS}k`)
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
