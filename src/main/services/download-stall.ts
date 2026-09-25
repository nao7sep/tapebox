/**
 * Stall detection for a running yt-dlp download. A transfer that prints nothing
 * for {@link DOWNLOAD_STALL_AFTER_MS} is reported as stalled (and un-reported
 * when output resumes); it is never killed, since only the user can tell a slow
 * source from a dead one. Post-processing (the ffmpeg merge of a large file) is
 * legitimately silent, so the watch disarms for good once it begins.
 */

import { DOWNLOAD_STALL_AFTER_MS } from '@shared/domain'

// yt-dlp prefixes each post-processor's output with its name in brackets.
const POST_PROCESSING_LINE =
  /^\[(Merger|Fixup\w*|VideoConvertor|VideoRemuxer|ExtractAudio|Metadata|EmbedSubtitle|EmbedThumbnail|FFmpeg\w*|MoveFiles|ModifyChapters|SponsorBlock|SplitChapters)\]/

export function isPostProcessingLine(line: string): boolean {
  return POST_PROCESSING_LINE.test(line)
}

export type StallWatch = {
  /** Feed every output line (progress lines included). */
  line: (line: string) => void
  stop: () => void
}

export function watchForStall(
  onChange: (stalled: boolean) => void,
  afterMs: number = DOWNLOAD_STALL_AFTER_MS,
): StallWatch {
  let timer: NodeJS.Timeout | null = null
  let stalled = false
  let armed = true
  const clear = () => {
    if (timer) clearTimeout(timer)
    timer = null
  }
  const setStalled = (next: boolean) => {
    if (stalled === next) return
    stalled = next
    onChange(next)
  }
  const arm = () => {
    clear()
    timer = setTimeout(() => {
      timer = null
      setStalled(true)
    }, afterMs)
  }
  arm()
  return {
    line: (line) => {
      if (!armed) return
      setStalled(false)
      if (isPostProcessingLine(line)) {
        armed = false
        clear()
        return
      }
      arm()
    },
    stop: () => {
      armed = false
      clear()
      setStalled(false)
    },
  }
}
