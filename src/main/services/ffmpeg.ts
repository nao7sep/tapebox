import { unlink } from 'node:fs/promises'
import { basename, join, resolve } from 'node:path'
import { nanoid } from 'nanoid'
import { binaryPath } from '@main/paths'
import { log } from '@main/io/logger'
import { writeFileAtomicVia } from '@main/io/atomic-file'
import { execCapture, makeLineBuffer, spawnStreaming, SubprocessError, waitForExit } from '@main/io/spawn'
import type { SidecarMedia } from '@shared/domain'

/**
 * ffmpeg subprocess service. Two jobs only: probe a downloaded file for technical
 * metadata, and normalize a source thumbnail to a single canonical JPEG. (TapeBox
 * does not transcode media — export copies files verbatim.)
 */

// `ffmpeg -i` is a quick metadata read, but a pathological file could wedge it;
// the idle watchdog turns that into a (caught) failure instead of a hang.
const PROBE_IDLE_TIMEOUT_MS = 30_000

// Thumbnail encoding — fixed, not user-configurable. Every poster image passes
// through saveThumbnailJpeg, so these literals are the one place the library's
// thumbnail format is decided. Values target a clean preview at modest size, not
// archival fidelity: a poster is only ever shown letterboxed in the player.
const THUMBNAIL_JPEG_QSCALE = 3      // ffmpeg mjpeg -q:v: 2 (best) … 31 (worst)
const THUMBNAIL_MAX_EDGE_PX = 1280   // cap the longer side; never upscales smaller art
const THUMBNAIL_IDLE_TIMEOUT_MS = 30_000

// How many recent ffmpeg output lines to keep so a failure can show what it said
// (mirrors yt-dlp's MAX_LOG_LINES; ffmpeg is terser, so a smaller tail suffices).
const MAX_LOG_LINES = 40

/**
 * The single gate through which every thumbnail is persisted. Transcodes a raw
 * source image (any format yt-dlp fetched) to a normalized JPEG at
 * {destDir}/{stem}.jpg and returns that basename — so the rest of the app never
 * has to wonder what format or quality a thumbnail is.
 *
 * Publishes through writeFileAtomicVia: ffmpeg writes a staging file, which is
 * then fsync'd and atomically renamed onto {stem}.jpg (and removed on failure).
 * This lets the source legitimately BE {stem}.jpg (a re-encode in place); the
 * source is removed afterwards unless it already was the destination. Throws on
 * failure — the caller decides whether a missing poster is fatal (it isn't) or
 * worth surfacing.
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
  // the extension, and a bare `.tmp` suffix leaves it "unable to choose an output
  // format". Named <stem>-<nanoid>.jpg per the atomic-write-temp-files convention
  // (nanoid substitutes for the usual `.tmp` role-extension, which ffmpeg can't
  // infer a format from); its own stem never equals `stem`, so findThumbnail
  // ignores it while it briefly exists.
  const stagePath = join(destDir, `${stem}-${nanoid(10)}.jpg`)

  await writeFileAtomicVia(
    finalPath,
    async (stage) => {
      const args = [
        '-hide_banner',
        '-i', sourceImagePath,
        // Fit within a MAX×MAX box preserving aspect, only ever shrinking: the box
        // is clamped to the source's own size, so a thumbnail smaller than the cap
        // is passed through untouched rather than upscaled. Commas inside the
        // expressions are arguments to min(), not filter separators, so no escaping
        // is needed in an argv array (unlike a shell).
        '-vf', `scale='min(${THUMBNAIL_MAX_EDGE_PX},iw)':'min(${THUMBNAIL_MAX_EDGE_PX},ih)':force_original_aspect_ratio=decrease`,
        '-q:v', String(THUMBNAIL_JPEG_QSCALE),
        // Write exactly one image to the fixed filename: the image2 muxer otherwise
        // expects a numbered sequence pattern (%03d) and warns without these.
        '-frames:v', '1',
        '-update', '1',
        '-y', stage,
      ]

      const child = spawnStreaming(binaryPath('ffmpeg'), args, { signal, idleTimeoutMs: THUMBNAIL_IDLE_TIMEOUT_MS })
      const recentLines: string[] = []
      const lineBuffer = makeLineBuffer((line) => {
        if (!line.trim()) return
        recentLines.push(line)
        if (recentLines.length > MAX_LOG_LINES) recentLines.shift()
      }, { splitOnCR: true })
      child.stdout.on('data', lineBuffer.feed)
      child.stderr.on('data', lineBuffer.feed)

      try {
        await waitForExit(child, { command: 'ffmpeg thumbnail' })
      } catch (err) {
        lineBuffer.flush() // drain the tail so the error carries ffmpeg's last words
        if (err instanceof SubprocessError) {
          throw new SubprocessError(err.command, err.exitCode, recentLines.join('\n').trim() || err.stderr)
        }
        throw err
      } finally {
        lineBuffer.flush()
      }
    },
    stagePath,
  )

  // The source is consumed. Drop it unless it WAS the destination (a jpg→jpg
  // re-encode), in which case writeFileAtomicVia already replaced it.
  if (resolve(sourceImagePath) !== resolve(finalPath)) await unlink(sourceImagePath).catch(() => {})
  log.info('thumbnail saved', { stem, source: basename(sourceImagePath) })
  return finalName
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
