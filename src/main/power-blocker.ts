import { powerSaveBlocker } from 'electron'
import { getSettings } from './store/config.js'
import { log } from './io/logger.js'

/**
 * Cross-platform "caffeinate" for playback: holds a single OS power assertion
 * while a tape is actually playing, so the machine doesn't sleep — and the screen
 * doesn't dim — mid-watch. Electron's powerSaveBlocker wraps the native mechanism
 * on each platform (IOKit assertions on macOS, SetThreadExecutionState on Windows,
 * a freedesktop D-Bus inhibit on Linux), and the OS releases the assertion
 * automatically if this process exits — so there's nothing to clean up on crash.
 *
 * We use 'prevent-display-sleep', not imagequeue's 'prevent-app-suspension': there
 * the goal is to keep background work running while the screen may sleep; here the
 * user is watching, so a player that let the display dim mid-video would be a bug.
 * 'prevent-display-sleep' keeps both the system and the screen awake. (As with any
 * such assertion, on macOS it still cannot defeat clamshell sleep, and on Linux it
 * is only honored by desktop environments that implement the inhibit interface.)
 *
 * Unlike imagequeue — where the work to protect (a generating task, a CLI job) is
 * main-process state it can poll — the only source of truth for "is a tape
 * playing" is the renderer's <video> element. So the renderer reports play/pause
 * transitions over IPC (see useKeepAwake), this module holds at most one assertion,
 * and it reconciles that assertion against the reported intent AND the
 * keepAwakeWhilePlaying setting. Reconciling on both the renderer report and the
 * settings update means toggling the setting takes effect immediately — turning it
 * off mid-playback releases the assertion at once, without a restart.
 */

let blockerId: number | null = null
// The renderer's last reported playback state for the open tape.
let videoPlaying = false

// The assertion is held only when the user has opted in (the default) AND a tape
// is actually playing.
function shouldStayAwake(): boolean {
  return getSettings().keepAwakeWhilePlaying && videoPlaying
}

// Idempotent: keeps at most one assertion alive. Starting twice would leak the
// first id, so we early-return when the desired state already holds.
function setWakeLock(active: boolean): void {
  if (active) {
    if (blockerId !== null && powerSaveBlocker.isStarted(blockerId)) return
    blockerId = powerSaveBlocker.start('prevent-display-sleep')
    log.info('wake lock acquired', { blockerId })
  } else {
    if (blockerId === null) return
    if (powerSaveBlocker.isStarted(blockerId)) powerSaveBlocker.stop(blockerId)
    log.info('wake lock released', { blockerId })
    blockerId = null
  }
}

/** The renderer reports a play/pause transition for the currently open tape. */
export function setVideoPlaying(playing: boolean): void {
  videoPlaying = playing
  setWakeLock(shouldStayAwake())
}

/**
 * Re-evaluate the assertion against the current setting. Called after a settings
 * update so toggling keepAwakeWhilePlaying takes effect within the same tick.
 */
export function reconcileWakeLock(): void {
  setWakeLock(shouldStayAwake())
}

/**
 * Release unconditionally — the window (and its <video>) is gone, or the app is
 * shutting down. The OS would release on process exit anyway; this keeps the
 * assertion from lingering on macOS, where the app stays alive after its last
 * window closes.
 */
export function releaseWakeLock(): void {
  videoPlaying = false
  setWakeLock(false)
}
