import { resolve } from 'node:path'
import { handle } from './handle'
import * as config from '@main/store/config'
import * as apiKeys from '@main/services/api-keys'
import * as queue from '@main/queue/manager'
import * as session from '@main/store/session'
import { paths } from '@main/paths'
import { reconcileWakeLock } from '@main/power-blocker'
import { relocateLibrary } from '@main/store/library-move'
import { log } from '@main/io/logger'
import { SettingsSchema, type Settings } from '@shared/settings'

/**
 * The flat library files the app owns and tracks, as basenames — every tape's
 * media, its sidecar, and its (optional) thumbnail. This is what a relocation
 * moves: files the app created, never unrelated files the user dropped in the
 * folder. Deduplicated because the same basename can't legitimately repeat, but a
 * corrupt session could, and a duplicate would make the move's second pass fail.
 */
function trackedLibraryFiles(): string[] {
  const names = new Set<string>()
  for (const tape of session.getTapes()) {
    if (tape.filename) names.add(tape.filename)
    if (tape.sidecarFilename) names.add(tape.sidecarFilename)
    if (tape.thumbnailFilename) names.add(tape.thumbnailFilename)
  }
  return [...names]
}

/**
 * Resolve a persisted libraryDir value to its effective absolute path, the same way
 * getLibraryDir() does (blank/whitespace → the default library folder). Used to
 * compare the OLD effective dir against the NEW one a patch would produce, so the
 * move triggers on any real change — including custom→default and default→custom —
 * and no-ops when they resolve equal.
 */
function effectiveLibraryDir(libraryDir: string): string {
  return libraryDir.trim() || paths.library
}

/**
 * Relocate the library when a settings patch changes the effective library dir.
 * Runs the move BEFORE the new setting is committed: only if every file lands does
 * the caller persist libraryDir, so a failed move leaves the catalog pointing at the
 * intact source files under the OLD setting. A no-op (effective dir unchanged)
 * returns immediately and the normal update proceeds.
 *
 * In-flight downloads are refused, not drained: a job finalizes its media, sidecar,
 * and thumbnail straight into the current library dir, so moving the library out
 * from under one would strand or lose those files. Refusing is the simpler safe
 * option — the user finishes or stops downloads, then relocates.
 */
async function relocateIfLibraryDirChanged(patch: Partial<Settings>): Promise<void> {
  if (patch.libraryDir === undefined) return
  const fromDir = config.getLibraryDir()
  const toDir = effectiveLibraryDir(patch.libraryDir)
  if (resolve(fromDir) === resolve(toDir)) return

  if (queue.activeCount() > 0) {
    throw new Error(
      "Can't move the library while downloads are running. Finish or stop them first, then change the library folder.",
    )
  }

  const entries = trackedLibraryFiles()
  log.info('relocating library', { from: fromDir, to: toDir, files: entries.length })
  const result = await relocateLibrary(fromDir, toDir, entries)
  if (result.moved) {
    log.info('library relocated', { from: fromDir, to: toDir, count: result.count, crossDevice: result.crossDevice })
  }
}

export function registerSettingsHandlers(): void {
  handle('settings:get', async () => config.getSettings())
  // The default library folder, shown as the placeholder when libraryDir is blank.
  handle('settings:defaultLibraryDir', async () => paths.library)
  handle('settings:update', async (patch) => {
    const wasAutostart = config.getSettings().autoStartDownloads
    // Validate the full merged result BEFORE touching any files, so an invalid
    // sibling field in the same patch can't leave the library moved but the setting
    // unsaved. updateSettings re-validates too (this doesn't replace it); doing it
    // here just guarantees the move only runs for a patch that will persist.
    SettingsSchema.parse({ ...config.getSettings(), ...patch })
    // Move the library first; if it throws (collision, in-flight downloads, a
    // failed-and-rolled-back move) the new libraryDir is never committed, so the
    // renderer surfaces the error and the catalog still points at the old folder.
    await relocateIfLibraryDirChanged(patch)
    const next = await config.updateSettings(patch)
    // Flipping autostart on should start anything already waiting.
    if (!wasAutostart && next.autoStartDownloads) queue.resumePaused()
    // Toggling keep-awake off mid-playback must release the held wake lock now
    // (and toggling it on while a tape plays must acquire it) — reconcile against
    // the new setting rather than waiting for the next play/pause transition.
    reconcileWakeLock()
    return next
  })
  handle('settings:setApiKey', async ({ apiKey }) => {
    await apiKeys.writeAiKey(apiKey)
  })
  handle('settings:clearApiKey', async () => {
    await apiKeys.clearAiKey()
  })
  handle('settings:hasApiKey', async () => apiKeys.hasAiKey())
}
