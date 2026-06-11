import { app } from 'electron'
import icon from '../../resources/icon.png?asset'
import { log } from './io/logger.js'
import { describeError } from '@shared/error'

// Dev-only cosmetic: give the Dock tile TapeBox's icon while running under the
// prebuilt Electron.app binary, which otherwise shows Electron's default icon.
// `app.dock.setIcon` only overlays the in-memory tile — it does not change the
// on-disk bundle — so macOS discards it whenever it rebuilds the tile. The packaged
// build needs none of this: it gets its icon from build/icon.icns, and resources/
// is not shipped. setIcon throws if the image is unreadable, so it is guarded — a
// decorative icon must never stop the app from starting. macOS only; app.dock is
// undefined elsewhere.
//
// IMPORTANT (for anyone — human or AI — touching this): setting the icon ONCE at
// startup is NOT enough. macOS rebuilds the Dock tile from the on-disk bundle on
// several occasions, and each rebuild silently drops the overlay, so it must be
// RE-ASSERTED after every event that can rebuild the tile:
//   1. App launch — the first time the tile is drawn (startup → applyDevDockIcon).
//   2. app.on('activate') — Dock-icon click / app reopen. NOTE: 'activate' does NOT
//      fire when focus merely moves between windows, so it does not cover (3).
//   3. Leaving fullscreen — exiting the player's native <video> fullscreen un-hides
//      the Dock, rebuilding the tile. Wired from the window's leave-full-screen /
//      leave-html-full-screen events (see createMainWindow) through the deferred
//      re-assert below, because that particular rebuild is asynchronous.
// If you only see setIcon in the startup path, that is the bug — not the fix.
export function applyDevDockIcon(): void {
  if (process.platform !== 'darwin' || app.isPackaged) return
  try {
    app.dock?.setIcon(icon)
  } catch (err) {
    log.warn('failed to set dev dock icon', { error: describeError(err) })
  }
}

// Leaving fullscreen makes macOS rebuild the Dock tile from the on-disk bundle,
// dropping the overlay. That rebuild is ASYNCHRONOUS and rides the Dock un-hide
// animation, and there is NO event that fires once it settles — a single
// synchronous re-assert provably loses the race (setIcon succeeds, then the tile
// reverts). The repaint lands at a VARIABLE time, so we take several swings spread
// across the window it can land in:
//   0ms    — immediate, for the case the tile was never dropped.
//   300ms  — the common, fast repaint.
//   1000ms — a mid-range repaint.
//   3000ms — the late repaint; the swing that actually fixes the intermittent
//            misses. Raise it further if the tile still occasionally reverts.
// Best-effort and dev-only: setIcon is idempotent, so overlapping schedules from
// rapid fullscreen toggles are harmless, and every call re-checks the guards.
const DEV_DOCK_REASSERT_DELAYS_MS = [0, 300, 1000, 3000]

export function reassertDevDockIconAfterRepaint(): void {
  if (process.platform !== 'darwin' || app.isPackaged) return
  for (const delay of DEV_DOCK_REASSERT_DELAYS_MS) {
    setTimeout(applyDevDockIcon, delay)
  }
}
