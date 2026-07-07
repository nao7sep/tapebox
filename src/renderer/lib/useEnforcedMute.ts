import { useEffect, type RefObject } from 'react'

/**
 * Keep a <video> muted while `mute` is true. Muting is set imperatively (the
 * React `muted` prop doesn't reliably set the DOM property) and re-asserted on
 * every volumechange, so the native unmute button can't take effect — it reverts
 * instantly. Reapplies whenever the source changes (srcKey). When `mute` is false
 * this does nothing, leaving the user in control of volume.
 */
export function useEnforcedMute(
  videoRef: RefObject<HTMLVideoElement | null>,
  mute: boolean,
  srcKey: string | null,
): void {
  useEffect(() => {
    const video = videoRef.current
    if (!video || !mute) return
    video.muted = true
    const reassert = () => {
      if (!video.muted) video.muted = true
    }
    video.addEventListener('volumechange', reassert)
    return () => video.removeEventListener('volumechange', reassert)
  }, [videoRef, mute, srcKey])
}
