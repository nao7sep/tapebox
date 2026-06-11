import { forwardRef, useEffect, useState } from 'react'

type Props = {
  src: string
  /** Local poster URL, shown only while idle (see below). */
  posterSrc?: string
  autoPlay?: boolean
  muted?: boolean
  /** Fired when the <video> raises an error; receives the element to inspect. */
  onError?: (video: HTMLVideoElement) => void
}

/**
 * Thin wrapper around the native <video> element. Forwards a ref so the
 * parent (DetailPane) can call .currentTime = x when a chapter is clicked.
 *
 * The poster is shown only while the tape is idle — before anything has played.
 * Auto-play never shows it; the moment playback or a seek begins it's dropped, so
 * the gap before the first frame decodes is plain black rather than a flash of the
 * thumbnail. (The native poster otherwise lingers until the first frame paints,
 * which is the flash.) Resetting per source keeps the next tape's idle poster.
 */
export const Player = forwardRef<HTMLVideoElement, Props>(function Player({ src, posterSrc, autoPlay, muted, onError }, ref) {
  const [showPoster, setShowPoster] = useState(!autoPlay)
  useEffect(() => { setShowPoster(!autoPlay) }, [src, autoPlay])

  return (
    <video
      ref={ref}
      src={src}
      poster={showPoster ? posterSrc : undefined}
      autoPlay={autoPlay}
      muted={muted}
      onPlay={() => setShowPoster(false)}
      onSeeking={() => setShowPoster(false)}
      onError={(e) => onError?.(e.currentTarget)}
      controls
      preload="metadata"
      // Fill the available box and object-contain the frame: the video scales to
      // fit the preview — up for small clips, down for large — always preserving
      // aspect (letterboxed), never cropped. (max-w/max-h would leave a small
      // clip at its native, sub-preview size.)
      className="h-full w-full rounded bg-black object-contain"
    />
  )
})
