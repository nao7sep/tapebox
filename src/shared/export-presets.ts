/**
 * Export format catalog — the single source of truth for "what can a tape be
 * exported as." Pure data + predicates; importable from main (to build ffmpeg
 * args) and renderer (to render the modal) without pulling in either side.
 *
 * A preset fixes the container + codecs. Quality is a separate, optional knob:
 *   - lossy audio  -> bitrate (kbps)
 *   - re-encoded video -> max height (downscale only)
 * Copy/remux presets re-use the source streams bit-for-bit; their container is
 * derived from the source file (ext === null) rather than fixed.
 */

export type AudioCodec = 'copy' | 'aac' | 'libmp3lame' | 'libopus' | 'flac'
export type VideoCodec = 'copy' | 'libx264' | 'libx265' | 'libvpx-vp9'

type PresetBase = {
  id: string
  label: string
  /** Fixed container extension, or null to derive from the source (copy/remux). */
  ext: string | null
}

export type AudioPreset = PresetBase & { kind: 'audio'; acodec: AudioCodec }
export type VideoPreset = PresetBase & { kind: 'video'; vcodec: VideoCodec; acodec: AudioCodec }
export type ExportPreset = AudioPreset | VideoPreset

export const EXPORT_PRESETS: ExportPreset[] = [
  // ── Audio: drop the video track, keep/encode the audio. ──────────────────
  { kind: 'audio', id: 'audio-copy', label: 'Audio · copy (no re-encode)', ext: null, acodec: 'copy' },
  { kind: 'audio', id: 'audio-aac', label: 'Audio · AAC (.m4a)', ext: 'm4a', acodec: 'aac' },
  { kind: 'audio', id: 'audio-mp3', label: 'Audio · MP3 (.mp3)', ext: 'mp3', acodec: 'libmp3lame' },
  { kind: 'audio', id: 'audio-opus', label: 'Audio · Opus (.opus)', ext: 'opus', acodec: 'libopus' },
  { kind: 'audio', id: 'audio-flac', label: 'Audio · FLAC (.flac)', ext: 'flac', acodec: 'flac' },

  // ── Video: keep/encode both tracks. ──────────────────────────────────────
  { kind: 'video', id: 'video-copy', label: 'Video · remux (no re-encode)', ext: null, vcodec: 'copy', acodec: 'copy' },
  { kind: 'video', id: 'video-h264', label: 'Video · H.264 (.mp4)', ext: 'mp4', vcodec: 'libx264', acodec: 'aac' },
  { kind: 'video', id: 'video-h265', label: 'Video · H.265/HEVC (.mp4)', ext: 'mp4', vcodec: 'libx265', acodec: 'aac' },
  { kind: 'video', id: 'video-vp9', label: 'Video · VP9 (.webm)', ext: 'webm', vcodec: 'libvpx-vp9', acodec: 'libopus' },
]

/** Selectable audio bitrates (kbps), high → low. */
export const AUDIO_BITRATES_KBPS = [320, 256, 192, 128, 96] as const
export const DEFAULT_AUDIO_BITRATE_KBPS = 192

/** Selectable downscale caps; null = keep the source resolution. */
export const VIDEO_MAX_HEIGHTS: Array<number | null> = [null, 1080, 720, 480, 360]

/** Frame-rate caps; null = keep the source rate. */
export const VIDEO_FPS_CAPS: Array<number | null> = [null, 60, 30, 24]

/** Output channel layout when re-encoding audio. 'source' keeps the original. */
export const AUDIO_CHANNEL_OPTIONS = [
  { id: 'source', label: 'Source' },
  { id: 'stereo', label: 'Stereo' },
  { id: 'mono', label: 'Mono' },
] as const
export type AudioChannels = (typeof AUDIO_CHANNEL_OPTIONS)[number]['id']

/** Quality tier for a re-encoded video stream; maps to a CRF per codec. */
export const VIDEO_QUALITY_OPTIONS = [
  { id: 'higher', label: 'Higher quality (larger)' },
  { id: 'balanced', label: 'Balanced' },
  { id: 'smaller', label: 'Smaller file (lower)' },
] as const
export type VideoQuality = (typeof VIDEO_QUALITY_OPTIONS)[number]['id']
export const DEFAULT_VIDEO_QUALITY: VideoQuality = 'balanced'

/** Encoder speed/effort tier; trades encode time for file size. */
export const ENCODE_SPEED_OPTIONS = [
  { id: 'fast', label: 'Faster' },
  { id: 'medium', label: 'Medium' },
  { id: 'slow', label: 'Slower (smaller)' },
] as const
export type EncodeSpeed = (typeof ENCODE_SPEED_OPTIONS)[number]['id']
export const DEFAULT_ENCODE_SPEED: EncodeSpeed = 'medium'

export function getPreset(id: string): ExportPreset | undefined {
  return EXPORT_PRESETS.find((p) => p.id === id)
}

export function isLossyAudio(codec: AudioCodec): boolean {
  return codec === 'aac' || codec === 'libmp3lame' || codec === 'libopus'
}

/** A bitrate selector is meaningful whenever the audio is re-encoded to a lossy
 *  codec — including a video preset's audio track. */
export function supportsBitrate(preset: ExportPreset): boolean {
  return isLossyAudio(preset.acodec)
}

/** True when the preset re-encodes the audio stream (so channel/normalize knobs apply). */
export function reencodesAudio(preset: ExportPreset): boolean {
  return preset.acodec !== 'copy'
}

/** True when the preset re-encodes the video stream (so quality/scale/fps knobs apply). */
export function reencodesVideo(preset: ExportPreset): boolean {
  return preset.kind === 'video' && preset.vcodec !== 'copy'
}

/** A downscale selector is meaningful only when the video stream is re-encoded. */
export function supportsDownscale(preset: ExportPreset): boolean {
  return reencodesVideo(preset)
}
