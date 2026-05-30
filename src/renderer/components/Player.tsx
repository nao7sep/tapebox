import { forwardRef } from 'react'

type Props = {
  src: string
  poster?: string
  autoPlay?: boolean
}

/**
 * Thin wrapper around the native <video> element. Forwards a ref so the
 * parent (DetailPane) can call .currentTime = x when a chapter is clicked.
 */
export const Player = forwardRef<HTMLVideoElement, Props>(function Player({ src, poster, autoPlay }, ref) {
  return (
    <video
      ref={ref}
      src={src}
      poster={poster}
      autoPlay={autoPlay}
      controls
      preload="metadata"
      // Fit the whole frame inside the available box (object-contain) so the
      // entire video is always visible — tall/vertical clips render narrow,
      // wide clips render short, neither is cropped or pushed off-screen.
      className="max-h-full max-w-full rounded bg-black object-contain"
    />
  )
})
