import { homedir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'
import { handle } from './handle'
import * as config from '@main/store/config'
import * as apiKeys from '@main/services/api-keys'
import * as queue from '@main/queue/manager'
import * as session from '@main/store/session'
import { paths } from '@main/paths'
import { reconcileWakeLock } from '@main/power-blocker'
import { applyThemePreference } from '@main/theme'
import { applyLanguagePreference } from '@main/i18n'
import {
  completeLibraryRelocation,
  relocateLibrary,
  rollbackLibraryRelocation,
  type RelocatedFile,
} from '@main/store/library-move'
import { log } from '@main/io/logger'
import { describeError } from '@shared/error'
import { emit } from './events'
import { cancelWork, runCancellable } from '@main/work-registry'
import { SettingsSchema, type Settings } from '@shared/settings'
import { UserFacingError } from '@main/user-facing-error'
import { withLibraryMove } from '@main/library-writes'
import type { IpcCalls } from '@shared/ipc-contract'
import { message } from '@shared/i18n/translate'

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
 * Normalize a user-typed folder setting (libraryDir, defaultExportDir) at the
 * boundary, before it is stored or used. Blank stays blank (= the app default);
 * a leading ~ / ~/ / ~\ expands to the home directory. The result must be
 * absolute — a relative path typed into the field is rejected here, so it can
 * never reach a path join and resolve against the working directory, which on a
 * double-clicked build is `/` (storage-path-conventions). The Choose… picker
 * always yields an absolute path, so this only ever rejects a hand-typed value.
 */
function normalizeUserDir(
  notAbsolute: 'errors.libraryFolderNotAbsolute' | 'errors.exportFolderNotAbsolute',
  value: string,
): string {
  const trimmed = value.trim()
  if (trimmed === '') return ''
  let expanded = trimmed
  if (expanded === '~') expanded = homedir()
  else if (expanded.startsWith('~/') || expanded.startsWith('~\\')) {
    expanded = join(homedir(), expanded.slice(2))
  }
  if (!isAbsolute(expanded)) {
    throw new UserFacingError('invalid', message(notAbsolute))
  }
  return expanded
}

/**
 * Relocate the library when a settings patch changes the effective library dir.
 * Publishes destination copies BEFORE the new setting is committed while retaining
 * every source claim. Only after config.json durably names the destination does the
 * caller clean the obsolete sources. A crash or failure before that commit leaves
 * the old libraryDir and every catalog-visible source coherent; a no-op (effective
 * dir unchanged) returns immediately and the normal update proceeds.
 *
 * It runs inside the library write gate (library-writes.ts), which refuses it while
 * any download, import, rename or export is writing into the current folder and
 * holds new ones off until the settings commit, so nothing is stranded in the old
 * folder.
 */
type CompletedRelocation = { fromDir: string; files: RelocatedFile[] }

/** Work-registry key for the one library move that can be in flight. */
const LIBRARY_MOVE_KEY = 'library-move'

/** True when applying `patch` would change the effective library folder. */
function movesLibrary(patch: Partial<Settings>): boolean {
  if (patch.libraryDir === undefined) return false
  return resolve(config.getLibraryDir()) !== resolve(effectiveLibraryDir(patch.libraryDir))
}

async function relocateIfLibraryDirChanged(
  patch: Partial<Settings>,
  signal: AbortSignal,
): Promise<CompletedRelocation | null> {
  if (!movesLibrary(patch)) return null
  const fromDir = config.getLibraryDir()
  const toDir = effectiveLibraryDir(patch.libraryDir!)

  const entries = trackedLibraryFiles()
  log.info('relocating library', { from: fromDir, to: toDir, files: entries.length })
  const result = await relocateLibrary(fromDir, toDir, entries, {
    signal,
    onProgress: (progress) => emit('settings:libraryMoveProgress', progress),
  })
  if (result.moved) {
    log.info('library destinations published; awaiting settings commit', {
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
  // The default library folder, shown as the placeholder when libraryDir is blank.
  handle('settings:defaultLibraryDir', async () => paths.library)
  handle('settings:update', async (patch) => {
    const wasAutostart = config.getSettings().autoStartDownloads
    // Normalize user-typed folder fields at the boundary: blank stays default, ~
    // expands, and a relative value is rejected here so it can never reach a path
    // join and resolve against the working directory (storage-path-conventions).
    const normalized: Partial<Settings> = { ...patch }
    if (patch.libraryDir !== undefined) {
      normalized.libraryDir = normalizeUserDir('errors.libraryFolderNotAbsolute', patch.libraryDir)
    }
    if (patch.defaultExportDir !== undefined) {
      normalized.defaultExportDir = normalizeUserDir('errors.exportFolderNotAbsolute', patch.defaultExportDir)
    }
    // Validate the full merged result BEFORE touching any files, so an invalid
    // sibling field in the same patch can't leave the library moved but the setting
    // unsaved. updateSettings re-validates too (this doesn't replace it); doing it
    // here just guarantees the move only runs for a patch that will persist.
    SettingsSchema.parse({ ...config.getSettings(), ...normalized })
    // Move the library first; if it throws (collision, library writes in flight,
    // a failed-and-rolled-back move) the new libraryDir is never committed, so the
    // renderer surfaces the error and the catalog still points at the old folder.
    // The write gate is held for the whole move and settings commit so no download,
    // import or rename writes into the old folder meanwhile; the queue catches up
    // after. Stop (settings:cancelLibraryMove) or quitting aborts the copy and rolls
    // back every file already published.
    const apply = () => runCancellable(
      (signal) => applySettingsPatch(normalized, wasAutostart, signal),
      LIBRARY_MOVE_KEY,
    )
    if (!movesLibrary(normalized)) return apply()
    try {
      return await withLibraryMove(apply)
    } finally {
      queue.tick()
    }
  })
  handle('settings:cancelLibraryMove', async () => {
    cancelWork(LIBRARY_MOVE_KEY)
  })
  handle('settings:setApiKey', async ({ apiKey }) => {
    await apiKeys.writeApiKey(['openai'], apiKey)
  })
  handle('settings:clearApiKey', async () => {
    await apiKeys.clearApiKey(['openai'])
  })
  handle('settings:hasApiKey', async () => apiKeys.hasApiKey(['openai']))
}

type SettingsUpdateResult = IpcCalls['settings:update']['res']

/** Shown when the new library folder is committed but old copies remain in the previous one. */
const OBSOLETE_SOURCES_WARNING = message('errors.libraryOldCopiesKept')

async function applySettingsPatch(
  normalized: Partial<Settings>,
  wasAutostart: boolean,
  signal: AbortSignal,
): Promise<SettingsUpdateResult> {
  const relocation = await relocateIfLibraryDirChanged(normalized, signal)
  let next: Settings
  try {
    next = await config.updateSettings(normalized)
  } catch (saveError) {
    if (relocation) {
      try {
        await rollbackLibraryRelocation(relocation.files)
        log.info('library destinations rolled back after settings save failure', {
          source: relocation.fromDir,
          files: relocation.files.length,
        })
      } catch (rollbackError) {
        throw new AggregateError(
          [saveError, rollbackError],
          'Settings could not be saved and the library relocation could not be fully rolled back.',
        )
      }
    }
    throw saveError
  }
  // Settings apply on Save, the theme (app-chrome conventions, Theme) and the
  // language (localization-conventions) included.
  applyThemePreference(next.theme)
  applyLanguagePreference(next.language)
  // Flipping autostart on should start anything already waiting.
  if (!wasAutostart && next.autoStartDownloads) queue.resumePaused()
  // Toggling keep-awake off mid-playback must release the held wake lock now
  // (and toggling it on while a tape plays must acquire it) — reconcile against
  // the new setting rather than waiting for the next play/pause transition.
  reconcileWakeLock()
  // The commit above is the outcome: the new folder is authoritative, so a failed
  // cleanup of the old copies is a warning on a successful save, never a failure.
  if (relocation) {
    try {
      await completeLibraryRelocation(relocation.files)
      log.info('obsolete library sources cleaned after settings commit', {
        from: relocation.fromDir,
        files: relocation.files.length,
      })
    } catch (cleanupError) {
      log.error('obsolete library source cleanup incomplete after settings commit', {
        from: relocation.fromDir,
        error: describeError(cleanupError),
      })
      return { settings: next, warning: OBSOLETE_SOURCES_WARNING }
    }
  }
  return { settings: next, warning: null }
}

