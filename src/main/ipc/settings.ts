import { join, resolve } from 'node:path'
import { handle } from './handle'
import * as config from '@main/store/config'
import { normalizeUserDir } from '@main/core/user-directory'
import * as apiKeys from '@main/services/api-keys'
import * as queue from '@main/queue/manager'
import * as session from '@main/store/session'
import { INBOX_FOLDER, paths, SHELF_FOLDER } from '@main/paths'
import { notifyDamagedTapes } from '@main/startup-dialog'
import { reconcileWakeLock } from '@main/power-blocker'
import { applyThemePreference, systemAppearance } from '@main/theme'
import { applyLanguagePreference } from '@main/i18n'
import {
  completeCollectionRelocation,
  relocateCollection,
  rollbackCollectionRelocation,
  type RelocatedFile,
} from '@main/store/collection-move'
import { UserFacingError } from '@main/user-facing-error'
import { log } from '@main/io/logger'
import { describeError } from '@shared/error'
import { linkOrCopyNoOverwrite } from '@main/io/atomic-file'
import { emit } from './events'
import { cancelWork, runCancellable } from '@main/work-registry'
import { settingsAfterPatch, type Settings, type SettingsSets } from '@shared/settings'
import { withCollectionMove } from '@main/collection-writes'
import type { IpcCalls } from '@shared/ipc-contract'
import { message } from '@shared/i18n/translate'

/**
 * The collection-relative files the app tracks: shelf.json, and each tape's
 * tape.json, media, sidecar and optional thumbnail in its own folder under
 * inbox/ or shelf/. Relocation never adopts unrelated files the user dropped in
 * the folder.
 */
function trackedCollectionFiles(): string[] {
  const names = session.collectionStoreFiles()
  for (const tape of session.getTapes()) {
    for (const name of [tape.filename, tape.sidecarFilename, tape.thumbnailFilename]) {
      if (name) names.push(join(tape.shelved ? SHELF_FOLDER : INBOX_FOLDER, tape.id, name))
    }
  }
  return names
}

/**
 * Resolve a persisted collectionDir value to its effective absolute path, the same way
 * getCollectionDir() does (blank → the default collection folder). Used to
 * compare the OLD effective dir against the NEW one a patch would produce, so the
 * move triggers on any real change — including custom→default and default→custom —
 * and no-ops when they resolve equal.
 */
function effectiveCollectionDir(collectionDir: string): string {
  return collectionDir || paths.collection
}

/**
 * Relocate the collection when a settings patch changes the effective collection dir.
 * Publishes destination copies BEFORE the new setting is committed, keeping every
 * source. Only after config.json durably names the destination does the
 * caller clean the obsolete sources. A crash or failure before that commit leaves
 * the old collectionDir and every source the collection names coherent; a no-op (effective
 * dir unchanged) returns immediately and the normal update proceeds.
 *
 * It runs at its collection turn (collection-writes.ts), so no import, rename, export or
 * removal runs beside it; it refuses while a download runs, and none starts until
 * the settings commit, so nothing is stranded in the old folder. Collection changes
 * made meanwhile go through the session store, which carries them to the new folder.
 */
type CompletedRelocation = { fromDir: string; files: RelocatedFile[] }

/** Work-registry key for the one collection move that can be in flight. */
const COLLECTION_MOVE_KEY = 'collection-move'

/** True when applying `patch` would change the effective collection folder. */
function movesCollection(patch: SettingsSets): boolean {
  if (patch.collectionDir === undefined) return false
  return resolve(config.getCollectionDir()) !== resolve(effectiveCollectionDir(patch.collectionDir))
}

async function relocateIfCollectionDirChanged(
  patch: SettingsSets,
  signal: AbortSignal,
): Promise<CompletedRelocation | null> {
  if (!movesCollection(patch)) return null
  const fromDir = config.getCollectionDir()
  const toDir = effectiveCollectionDir(patch.collectionDir!)

  await session.prepareCollection()
  signal.throwIfAborted()
  const entries = trackedCollectionFiles()
  const storeFiles = new Set(session.collectionStoreFiles())
  log.info('relocating collection', { from: fromDir, to: toDir, files: entries.length })
  const result = await relocateCollection(fromDir, toDir, entries, {
    signal,
    onProgress: (progress) => emit('settings:collectionMoveProgress', progress),
    // The session store copies its own files, so no save can land mid-copy.
    publish: (name, source, destination, signal) => storeFiles.has(name)
      ? session.copyStoreFileTo(name, destination, signal)
      : linkOrCopyNoOverwrite(source, destination, signal),
  })
  if (result.moved) {
    log.info('collection destinations published; awaiting settings commit', {
      from: fromDir,
      to: toDir,
      count: result.count,
      crossDevice: result.crossDevice,
    })
  }
  return result.moved ? { fromDir, files: result.files } : null
}

export function registerSettingsHandlers(): void {
  handle('settings:get', async () => config.getSettings())
  // The default collection folder, shown as the placeholder when collectionDir is blank.
  handle('settings:defaultCollectionDir', async () => paths.collection)
  handle('settings:update', async ({ collectionAction, ...patch }) => {
    // Normalize user-typed folder fields at the boundary.
    const normalized: SettingsSets = { ...patch }
    if (patch.collectionDir !== undefined) {
      normalized.collectionDir = normalizeUserDir('errors.collectionFolderNotAbsolute', patch.collectionDir)
    }
    if (patch.defaultExportDir !== undefined) {
      normalized.defaultExportDir = normalizeUserDir('errors.exportFolderNotAbsolute', patch.defaultExportDir)
    }
    // Validate the full merged result BEFORE touching any files, so an invalid
    // sibling field in the same patch can't leave the collection moved but the setting
    // unsaved. updateSettings re-validates too (this doesn't replace it); doing it
    // here just guarantees the move only runs for a patch that will persist.
    settingsAfterPatch(config.getSettings(), normalized)
    // Move the collection first; if it throws (collision, downloads running,
    // a failed-and-rolled-back move) the new collectionDir is never committed, so the
    // renderer surfaces the error and the setting still points at the old folder.
    // The collection turn lasts for the whole move and settings commit so no download,
    // import or rename writes into the old folder meanwhile; the queue catches up
    // after. Stop (settings:cancelCollectionMove) or quitting aborts the copy and rolls
    // back every file already published.
    const apply = () => runCancellable(
      async (signal) => {
        try {
          return await applySettingsPatch(normalized, signal, collectionAction)
        } catch (error) {
          // Only the actual abort reason proves a clean stop. A filesystem or
          // rollback failure remains a failure even if Stop was also requested.
          if (signal.aborted && error === signal.reason) {
            throw new UserFacingError('cancelled', message('settings.moveStopped'))
          }
          throw error
        }
      },
      COLLECTION_MOVE_KEY,
    )
    if (!movesCollection(normalized)) return apply()
    try {
      return await withCollectionMove(() => {
        if (queue.hasActiveJobs()) throw new UserFacingError('refused', message('errors.collectionMoveBlocked'))
        return apply()
      })
    } finally {
      queue.tick()
    }
  })
  handle('settings:cancelCollectionMove', async () => {
    cancelWork(COLLECTION_MOVE_KEY)
  })
  handle('settings:setApiKey', async ({ apiKey }) => {
    await apiKeys.writeApiKey('openai', apiKey)
  })
  handle('settings:clearApiKey', async () => {
    await apiKeys.clearApiKey('openai')
  })
  handle('settings:apiKeyState', async () => apiKeys.apiKeyState('openai'))
  handle('settings:systemAppearance', () => systemAppearance())
}

type SettingsUpdateResult = IpcCalls['settings:update']['res']

/** Shown when the new collection folder is committed but old copies remain in the previous one. */
const OBSOLETE_SOURCES_WARNING = message('errors.collectionOldCopiesKept')

async function applySettingsPatch(
  normalized: SettingsSets,
  signal: AbortSignal,
  collectionAction?: 'open',
): Promise<SettingsUpdateResult> {
  const previous = config.getSettings()
  const switching = movesCollection(normalized)
  const toDir = effectiveCollectionDir(normalized.collectionDir ?? config.getSettings().collectionDir)
  const opening = switching && collectionAction === 'open'
  // Inspect an explicitly opened collection without quarantine. It is never a
  // destination for the current collection's media or organization.
  const opened = opening
    ? await session.readCollection(toDir, { requireExisting: true }).catch((cause: unknown) => {
      throw new UserFacingError('refused', message('errors.collectionOpenFailed', { path: toDir }), { cause })
    })
    : null
  if (opening) await session.prepareCollection()
  signal.throwIfAborted()
  const relocation = opening ? null : await relocateIfCollectionDirChanged(normalized, signal)
  let next: Settings
  try {
    signal.throwIfAborted()
    next = await config.updateSettings(normalized)
  } catch (saveError) {
    if (relocation) {
      try {
        await rollbackCollectionRelocation(relocation.files)
        log.info('collection destinations rolled back after settings save failure', {
          source: relocation.fromDir,
          files: relocation.files.length,
        })
      } catch (rollbackError) {
        throw new AggregateError(
          [saveError, rollbackError],
          'Settings could not be saved and the collection relocation could not be fully rolled back.',
        )
      }
    }
    throw saveError
  }
  if (opened) {
    // Changes made to the current collection while it was being opened reach
    // its own files before the opened one replaces it.
    await session.persistNow()
    session.bindSession(toDir, opened)
    emit('collection:opened', opened.session)
    if (opened.damaged.length > 0) void notifyDamagedTapes(opened.damaged.map((tape) => tape.path))
  } else if (relocation) {
    await session.bindMovedSession(toDir)
  }
  // Settings apply on Save, the theme (app-chrome conventions, Theme) and the
  // language (localization-conventions) included.
  if (next.theme !== previous.theme) applyThemePreference(next.theme)
  // The language owner also retries a catalogue that previously failed to load.
  const languageApplied = await applyLanguagePreference(next.language)
  if (languageApplied || next.language !== previous.language) emit('settings:languageChanged', next.language)
  if (next.timeZone !== previous.timeZone) emit('settings:timeZoneChanged', next.timeZone)
  if (next.uiFontFamily !== previous.uiFontFamily) emit('settings:uiFontChanged', next.uiFontFamily)
  // Flipping autostart on should start anything already waiting.
  if (!previous.autoStartDownloads && next.autoStartDownloads) queue.resumePaused()
  else if (next.autoStartDownloads && next.maxConcurrentDownloads > previous.maxConcurrentDownloads) queue.tick()
  // Toggling keep-awake off mid-playback must release the held wake lock now
  // (and toggling it on while a tape plays must acquire it) — reconcile against
  // the new setting rather than waiting for the next play/pause transition.
  if (next.keepAwakeWhilePlaying !== previous.keepAwakeWhilePlaying) reconcileWakeLock()
  // The commit above is the outcome: the new folder is authoritative, so a failed
  // cleanup of the old copies is a warning on a successful save, never a failure.
  if (relocation) {
    try {
      await completeCollectionRelocation(relocation.files)
      log.info('obsolete collection sources cleaned after settings commit', {
        from: relocation.fromDir,
        files: relocation.files.length,
      })
    } catch (cleanupError) {
      log.error('obsolete collection source cleanup incomplete after settings commit', {
        from: relocation.fromDir,
        error: describeError(cleanupError),
      })
      return { settings: next, warning: OBSOLETE_SOURCES_WARNING }
    }
  }
  return { settings: next, warning: null }
}

