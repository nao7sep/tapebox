import { forwardRef } from 'react'

type Props = {
  src: string
  poster?: string
  autoPlay?: boolean
  muted?: boolean
}

/**
 * Thin wrapper around the native <video> element. Forwards a ref so the
 * parent (DetailPane) can call .currentTime = x when a chapter is clicked.
 */
export const Player = forwardRef<HTMLVideoElement, Props>(function Player({ src, poster, autoPlay, muted }, ref) {
  return (
    <video
      ref={ref}
      src={src}
      poster={poster}
      autoPlay={autoPlay}
      muted={muted}
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
