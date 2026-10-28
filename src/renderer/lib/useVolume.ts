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
 * Zero is the one muted state: the native mute button is turned into volume 0,
 * so the toolbar's speaker icon shows muted whenever the player is silent and
 * raising the volume restores sound. Nothing else mutes the element.
 *
 * Volume lives in the layout store, which already gives a value adjusted by the
 * drag a mirror-now, write-later path with rollback; the settings store saves
 * whole sets through the Settings dialog. The in-memory mirror is updated
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
    // HydratedApp mounts the player only after layout is available; keep the
    // guard so the hook still refuses to invent a level if that invariant drifts.
    const saved = useLayoutStore.getState().layout?.volume
    if (saved == null) return
    if (saved !== video.volume) video.volume = saved

    let last = video.volume
    let timer: ReturnType<typeof setTimeout> | undefined
    const onVolumeChange = () => {
      if (video.muted) {
        // Unmuting and zeroing each raise another volumechange; the second one
        // persists the 0.
        video.muted = false
        video.volume = 0
        return
      }
      const v = video.volume
      if (v === last) return
      last = v
      void patchLayout({ volume: v }, false) // mirror now: the next tape opens here
      clearTimeout(timer)
      // Debounce the disk write; clearing the ref on fire means the unmount flush
      // below only runs when a write is genuinely still outstanding.
      timer = setTimeout(() => {
        timer = undefined
        void patchLayout({ volume: v }, true)
      }, PERSIST_DELAY_MS)
    }
    // Store settlement (including rollback) must reach the surviving element.
    // Update the comparison value first so its volumechange cannot echo a write.
    const unsubscribe = useLayoutStore.subscribe((state) => {
      const volume = state.layout?.volume
      if (volume == null || volume === video.volume) return
      clearTimeout(timer)
      timer = undefined
      last = volume
      video.volume = volume
    })
    video.addEventListener('volumechange', onVolumeChange)
    return () => {
      unsubscribe()
      video.removeEventListener('volumechange', onVolumeChange)
      // Flush a still-pending debounced write so the final level reaches disk.
      if (timer) {
        clearTimeout(timer)
        void patchLayout({ volume: last }, true)
      }
    }
  }, [videoRef, srcKey])
}
