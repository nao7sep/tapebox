import type { RefObject } from 'react'
import type { Tape } from '@shared/domain'
import { mediaFileUrl, useMediaStore } from '@renderer/store/media'
import { useSelectionStore } from '@renderer/store/selection'
import { useTapesStore } from '@renderer/store/tapes'
import { releaseVideo } from '@renderer/lib/video'

/** Release file use through the command's settlement, then restore only the same
 * surviving tape. A command that finds the player already released leaves the
 * restore to the command that released it.
 */
export async function withReleasedTapeVideo<T>(
  tape: Tape,
  videoRef: RefObject<HTMLVideoElement | null>,
  work: () => Promise<T>,
): Promise<T> {
  const video = videoRef.current
  const source = mediaFileUrl(useMediaStore.getState(), tape.filename)
  if (!video || !source || video.getAttribute('src') !== source) return work()
  const playback = { at: video.currentTime, play: !video.paused && !video.ended }
  releaseVideo(video)
  try {
    return await work()
  } finally {
    const stillOwnsPlayer = () => {
      const current = useTapesStore.getState().tapes.find(item => item.id === tape.id)
      return videoRef.current === video && video.isConnected && useSelectionStore.getState().selectedId === tape.id &&
        current?.state === 'downloaded' && mediaFileUrl(useMediaStore.getState(), current.filename) === source
    }
    if (stillOwnsPlayer() && !video.hasAttribute('src')) {
      video.autoplay = playback.play
      video.addEventListener('loadedmetadata', () => {
        if (!stillOwnsPlayer() || video.getAttribute('src') !== source) return
        try { video.currentTime = playback.at } catch { /* Media may now be shorter. */ }
        if (playback.play) void video.play().catch(() => {})
      }, { once: true })
      video.src = source
      video.load()
    }
  }
}
