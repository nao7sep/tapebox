import { forwardRef } from 'react'

type Props = {
  src: string
  poster?: string
}

/**
 * Thin wrapper around the native <video> element. Forwards a ref so the
 * parent (DetailPane) can call .currentTime = x when a chapter is clicked.
 */
export const Player = forwardRef<HTMLVideoElement, Props>(function Player({ src, poster }, ref) {
  return (
    <video
      ref={ref}
      src={src}
      poster={poster}
      controls
      preload="metadata"
      className="w-full rounded bg-black"
    />
  )
})
