import { useEffect, type RefObject } from 'react'
import { ipcInvoke } from '@renderer/ipc/client'

/**
 * Report the <video>'s play/pause state to the main process, which holds an OS
 * wake lock for as long as a tape is actually playing — so the screen won't dim
 * and the machine won't sleep mid-watch — and releases it the moment playback
 * pauses, ends, the source changes, or the player closes.
 *
 * This hook reports playback truth only; whether that truth holds a wake lock is
 * decided entirely in the main process, gated by the keepAwakeWhilePlaying setting
 * (see power-blocker.ts). Keeping the gate there — rather than also gating here —
 * means main always knows the real play state, so toggling the setting on while a
 * tape is already playing engages the lock at once instead of waiting on a render.
 *
 * "Playing" is `!paused && !ended`: this stays true through buffering (the user
 * pressed play; it's just waiting for data), so a long stall doesn't let the
 * machine sleep. Reapplies whenever the player mounts or its source changes
 * (srcKey); when no <video> is mounted it reports not-playing.
 */
export function useKeepAwake(
  videoRef: RefObject<HTMLVideoElement | null>,
  srcKey: string | null,
): void {
  useEffect(() => {
    const report = (playing: boolean) => {
      // Main logs the authoritative failure (handle() re-throws); swallow here so a
      // rejected report never surfaces as an unhandledrejection.
      void ipcInvoke('app:setVideoPlaying', { playing }).catch(() => {})
    }

    const video = videoRef.current
    if (!video) {
      // No player mounted: make sure any prior hold is released.
      report(false)
      return
    }

    const sync = () => report(!video.paused && !video.ended)
    sync()
    const events = ['play', 'playing', 'pause', 'ended', 'emptied', 'waiting'] as const
    events.forEach((e) => video.addEventListener(e, sync))
    return () => {
      events.forEach((e) => video.removeEventListener(e, sync))
      // Leaving this source must never leave the lock held.
      report(false)
    }
  }, [videoRef, srcKey])
}
