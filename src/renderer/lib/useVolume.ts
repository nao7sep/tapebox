import { useEffect, type RefObject } from 'react'
import { useLayoutStore, patchLayout } from '@renderer/store/layout'

/** How long the volume must settle before the change is written to disk. */
const PERSIST_DELAY_MS = 500

/**
 * Carry the player's volume across tapes and restarts. A fresh <video> always
 * starts at full volume, so without this the user's chosen level resets every
 * time they switch tapes; here we apply the saved level to each newly-mounted
 * element (keyed on srcKey) and remember whatever they dial in.
 *
 * Volume (loudness) is independent of the muted flag that useEnforcedMute owns,
 * so the two don't interact: this persists the level whether or not sound is on.
 *
 * Volume is view state, so it lives in the layout store, not settings
 * (persisted-store-separation-conventions). The in-memory mirror is updated
 * immediately (so the *next* tape opens at the current level even mid-drag), while
 * the disk write is debounced — the native volume slider fires a flurry of
 * volumechange events, and one layout write per pixel would thrash the file. A
 * pending write is flushed on unmount so the last adjustment before a fast
 * tape-switch still survives a restart.
 */
export function useVolume(videoRef: RefObject<HTMLVideoElement | null>, srcKey: string | null): void {
  useEffect(() => {
    const video = videoRef.current
    if (!video) return

    // Apply the saved level to this source. Read once, before attaching the
    // listener, so this programmatic set never re-enters as a change to persist.
    // The layout store is seeded with defaults (never null), so the level is
    // always a concrete number.
    const saved = useLayoutStore.getState().layout.volume
    if (saved !== video.volume) video.volume = saved

    let last = video.volume
    let timer: ReturnType<typeof setTimeout> | undefined
    const onVolumeChange = () => {
      const v = video.volume
      if (v === last) return
      last = v
      patchLayout({ volume: v }, false) // mirror now: the next tape opens here
      clearTimeout(timer)
      // Debounce the disk write; clearing the ref on fire means the unmount flush
      // below only runs when a write is genuinely still outstanding.
      timer = setTimeout(() => {
        timer = undefined
        patchLayout({ volume: v }, true)
      }, PERSIST_DELAY_MS)
    }
    video.addEventListener('volumechange', onVolumeChange)
    return () => {
      video.removeEventListener('volumechange', onVolumeChange)
      // Flush a still-pending debounced write so the final level reaches disk.
      if (timer) {
        clearTimeout(timer)
        patchLayout({ volume: last }, true)
      }
    }
  }, [videoRef, srcKey])
}
