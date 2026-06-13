import { forwardRef, useEffect, useRef, useState, type Ref } from 'react'

type Props = {
  src: string
  /** Local poster URL, shown only while idle (see below). */
  posterSrc?: string
  autoPlay?: boolean
  muted?: boolean
  /** Fired when the <video> raises an error; receives the element to inspect. */
  onError?: (video: HTMLVideoElement) => void
  /** Fired once the new source's metadata is ready (so the parent can seek). Used
   *  to restore the playback position after a rename swaps the file underneath. */
  onLoadedMetadata?: () => void
}

/**
 * Native <video> on a black backdrop, forwarding a ref so the parent (DetailPane)
 * can drive .currentTime.
 *
 * The element is keyed by `src` so each source is a fresh element. That matters for
 * the reveal logic below: under fast source switching (holding ↑/↓ through the
 * list), the pending frame callback is torn down with the old element, so a late
 * frame from a previous tape can never reveal the wrong one.
 *
 * Idle poster: shown only before anything plays, and only when a thumbnail exists.
 * Auto-play never shows it.
 */
export const Player = forwardRef<HTMLVideoElement, Props>(function Player(props, ref) {
  return (
    <div className="flex h-full w-full items-center justify-center overflow-hidden rounded bg-black">
      <VideoSurface key={props.src} {...props} forwardedRef={ref} />
    </div>
  )
})

/**
 * Holds the element transparent over the backdrop until a real frame has been
 * *presented* — not merely until data has loaded. On macOS a <video>'s hardware
 * surface can paint solid white/grey before its first decoded frame, and CSS
 * `background` doesn't cover that surface, so revealing on `loadeddata` un-hides a
 * still-blank element (the grey preview seen when switching tapes). requestVideo-
 * FrameCallback fires on the first composited frame, which is the correct moment.
 *
 * Three reveal paths: the first presented frame (normal video); `loadedmetadata`
 * with no video track (audio-only — there's no frame to wait for); and a timeout
 * backstop so an element never stays hidden if neither fires.
 */
function VideoSurface({
  src,
  posterSrc,
  autoPlay,
  muted,
  onError,
  onLoadedMetadata,
  forwardedRef,
}: Props & { forwardedRef: Ref<HTMLVideoElement> }) {
  const elRef = useRef<HTMLVideoElement | null>(null)
  const [showPoster, setShowPoster] = useState(!autoPlay)
  const [ready, setReady] = useState(false)

  useEffect(() => { setShowPoster(!autoPlay) }, [autoPlay])

  useEffect(() => {
    const v = elRef.current
    if (!v) return
    let done = false
    const reveal = () => { if (!done) { done = true; setReady(true) } }

    let rvfcId = 0
    if (typeof v.requestVideoFrameCallback === 'function') {
      rvfcId = v.requestVideoFrameCallback(() => reveal())
    } else {
      // No frame-callback support: fall back to data-ready (older engines don't
      // exhibit the blank-surface flash this guards against).
      v.addEventListener('loadeddata', reveal, { once: true })
    }
    // Audio-only files never present a video frame; reveal so the controls show.
    const onMeta = () => { if (v.videoWidth === 0) reveal() }
    v.addEventListener('loadedmetadata', onMeta)
    const fallback = setTimeout(reveal, 2000)

    return () => {
      done = true
      if (rvfcId) v.cancelVideoFrameCallback?.(rvfcId)
      v.removeEventListener('loadeddata', reveal)
      v.removeEventListener('loadedmetadata', onMeta)
      clearTimeout(fallback)
    }
  }, [])

  const visible = ready || (showPoster && !!posterSrc)

  return (
    <video
      ref={(el) => {
        elRef.current = el
        if (typeof forwardedRef === 'function') forwardedRef(el)
        else if (forwardedRef) (forwardedRef as { current: HTMLVideoElement | null }).current = el
      }}
      src={src}
      poster={showPoster ? posterSrc : undefined}
      autoPlay={autoPlay}
      muted={muted}
      onPlay={() => setShowPoster(false)}
      onSeeking={() => setShowPoster(false)}
      onLoadedMetadata={() => onLoadedMetadata?.()}
      onError={(e) => onError?.(e.currentTarget)}
      controls
      // Buffer the whole (local) file so seeks land in already-loaded data instead
      // of stalling mid-playback — a stall flips the native pause button to play.
      preload="auto"
      // Fill the box and object-contain the frame: scaled to fit, aspect preserved
      // (letterboxed against the backdrop), never cropped. No focus ring: the player
      // is a large surface where a ring reads as heavy, and the native controls show
      // interaction; this opts out of the global keyboard-focus ring too.
      className={'h-full w-full bg-black object-contain focus:outline-none focus-visible:outline-none ' + (visible ? 'opacity-100' : 'opacity-0')}
    />
  )
}
