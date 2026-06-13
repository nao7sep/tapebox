import { useEffect, useRef, useState, type RefObject } from 'react'

/** Just the field the lookup needs; chapters arrive sorted by start_time. */
type ChapterLike = { start_time: number }

/**
 * Index of the chapter that contains time `t`: the last chapter whose `start_time`
 * is at or before `t`. Before the first chapter's start it returns 0 (the first
 * chapter is "current" from the very beginning); -1 only when there are no
 * chapters. Pure — assumes ascending `start_time`, as yt-dlp writes them.
 */
export function chapterIndexForTime(chapters: readonly ChapterLike[], t: number): number {
  if (chapters.length === 0) return -1
  let idx = 0
  for (let i = 0; i < chapters.length; i++) {
    if (chapters[i].start_time <= t) idx = i
    else break
  }
  return idx
}

/**
 * The chapter currently under the playhead, derived from the <video>'s position so
 * the highlight follows playback (and Up/Down jumps relative to where you actually
 * are, not a stale selection). Recomputes on play progress, seeks, and metadata
 * load, but only updates state when the index *changes* — `timeupdate` fires several
 * times a second, and the change is gated through a ref so an unchanged tick doesn't
 * re-render the (heavy) detail pane at all. Re-attaches when the source changes
 * (srcKey) or the chapter set loads. -1 when no chapters.
 *
 * `chapters` must be referentially stable across renders (memoize it) or the effect
 * re-binds on every render; DetailPane memoizes it from the sidecar.
 */
export function useCurrentChapter(
  videoRef: RefObject<HTMLVideoElement | null>,
  chapters: readonly ChapterLike[],
  srcKey: string | null,
): number {
  const [index, setIndex] = useState(() => (chapters.length === 0 ? -1 : 0))
  // Mirror of `index`, read synchronously so an unchanged tick skips setIndex
  // entirely. setIndex with an updater would still re-run this component each tick
  // (React evaluates the updater before bailing); the ref avoids the call outright.
  const indexRef = useRef(index)
  const set = (next: number) => {
    if (next !== indexRef.current) {
      indexRef.current = next
      setIndex(next)
    }
  }

  useEffect(() => {
    const video = videoRef.current
    if (!video || chapters.length === 0) {
      set(chapters.length === 0 ? -1 : 0)
      return
    }
    const sync = () => set(chapterIndexForTime(chapters, video.currentTime))
    sync()
    const events = ['timeupdate', 'seeked', 'loadedmetadata'] as const
    events.forEach((e) => video.addEventListener(e, sync))
    return () => events.forEach((e) => video.removeEventListener(e, sync))
  }, [videoRef, chapters, srcKey])

  return index
}
