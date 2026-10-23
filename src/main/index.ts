import { pathToFileURL } from 'node:url'
import { trustApplicationDocument } from './ipc/trust'
import { app, BrowserWindow, powerMonitor, shell } from 'electron'
import { join } from 'node:path'
import { ensureDirs, paths, sweepAbandonedStaging } from './paths.js'
import { notifyCorruptConfig, notifyCorruptSession, notifySettingsKept, notifyStartupFailure } from './startup-dialog.js'
import { initLogger, isDebugEnabled, log } from './io/logger.js'
import { closeRecords, flushRecordsBeforeExit, onRecordStored, openRecords } from './io/records.js'
import { closeRecordsReader } from './io/records-read.js'
import { notifyRecordsChanged } from './records-window.js'
import { describeError } from '@shared/error'
import { getSettings, loadSettings } from './store/config.js'
import { loadDependencies } from './store/dependencies.js'
import { loadSession, persistNow } from './store/session.js'
import * as layout from './store/layout.js'
import { registerIpcHandlers } from './ipc/index.js'
import { resumeBinaryOperations, shutdownBinaryOperations } from './ipc/binaries.js'
import * as queue from './queue/manager.js'
import { cancelAllScans, hasActiveScans, resumeScans } from './ipc/scan.js'
import { cancelAllWork, hasRunningWork, resumeWork } from './work-registry.js'
import { startMediaServer, stopMediaServer } from './media-server.js'
import { releaseWakeLock } from './power-blocker.js'
import { windowOptions } from './window-options.js'
import { applyThemePreference, followOsThemeChanges, windowBackground } from './theme.js'
import { createWindowWithUsablePersistedBounds } from './window-state-recovery.js'
import { configureWindowMinimum } from './window-minimum.js'
import { closeBackupStore } from './store/backupStore.js'
import { isImportableUrl } from '@shared/url'
import { settleTerminalStartupFailure } from './terminal-startup-failure.js'
import { configureWindowActivity } from './window-activity.js'
import { configureWindowClose, registerDraftAnswers, settleWindowDrafts } from './window-close.js'
import { hasInstalls } from './binaries/manager.js'
import { createQuit, type QuitChoice } from './quit.js'
import { forceExitProcess } from './force-exit.js'
import { killOwnedProcessesNow } from './io/spawn.js'
import { showPlainMessageDialog } from './plain-message-dialog.js'
import { setAboutRequest } from './menu.js'
import { sendTo } from './ipc/events.js'
import { WINDOW_MIN_HEIGHT, WINDOW_MIN_WIDTH } from '@shared/layout'
import {
  applyLanguagePreference,
  registerLanguageHandlers,
  mainTranslator,
  settleLanguageBeforeReady,
  settleLanguageWhenReady,
} from './i18n.js'


// Electron keeps its profile, window placement and single-instance lock in
// userData, set before anything reads it: under the storage root, so a relocated
// root keeps its own (paths.ts). An unusable override leaves Electron's default;
// startup's ensureDirs reports it and stops.
try {
  app.setPath('userData', paths.electronProfile)
} catch (error) {
  console.warn('tapebox: Electron profile stays in its default location:', error)
}

/**
 * Single-instance lock. If another tapebox instance already holds the lock,
 * focus its window and quit ourselves. Must run before app.whenReady() because
 * the second process should never start its own event loop.
 */
if (!app.requestSingleInstanceLock()) {
  app.quit()
  process.exit(0)
}

app.on('second-instance', () => {
  showOrCreateMainWindow()
})

// The app menu's About is the user asking for the main window's About dialog.
setAboutRequest(() => {
  showOrCreateMainWindow()
  const win = mainWindow
  if (win && !win.isDestroyed()) sendTo(win.webContents, 'app:showAbout', null)
})

// The interface language is known before anything is drawn: Chromium's own
// strings take it from a switch that only applies before ready.
settleLanguageBeforeReady()

let mainWindow: BrowserWindow | null = null
let startupReady = false
let terminalStartupFailure = false

async function createMainWindow(): Promise<BrowserWindow> {
  if (mainWindow && !mainWindow.isDestroyed()) return mainWindow
  const options = windowOptions(join(import.meta.dirname, '../preload/index.cjs'), windowBackground())
  const win = createWindowWithUsablePersistedBounds('main', () => new BrowserWindow(options))
  mainWindow = win
  configureWindowClose(win, () => app.quit())
  configureWindowActivity(app, win)
  configureWindowMinimum(win, () => ({ width: WINDOW_MIN_WIDTH, height: WINDOW_MIN_HEIGHT }),
    (error) => log.warn('window minimum could not be updated', { error: describeError(error) }))
  // Windows ends a logoff or shutdown here and never raises a quit event.
  win.on('session-end', quit.endSessionNow)
  win.once('closed', () => {
    if (mainWindow === win) mainWindow = null
    // A main window gone by any other route still ends the app; the Records
    // window beside it never keeps it running (window-conventions).
    app.quit()
  })

  // Open external links (About modal, etc.) in the OS browser, never a new
  // Electron window.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (isImportableUrl(url)) {
      void shell.openExternal(url).catch((error) => {
        log.error('external URL open failed', { error: describeError(error) })
      })
    }
    else log.warn('blocked external URL scheme')
    return { action: 'deny' }
  })

  const devUrl = process.env['ELECTRON_RENDERER_URL']
  trustApplicationDocument(win.webContents, devUrl ? devUrl : pathToFileURL(join(import.meta.dirname, '../renderer/index.html')).href)
  try {
    if (devUrl) await win.loadURL(devUrl)
    else await win.loadFile(join(import.meta.dirname, '../renderer/index.html'))
  } catch (error) {
    log.error('main window document failed to load', { error: describeError(error) })
    // Keep the failed, never-shown owner alive until the terminal recovery
    // surface settles; destroying the last window can begin normal shutdown
    // before that surface is created.
    throw error
  }

  win.show()
  return win
}

/** The window a quit question or error sits above: the focused app window, else
 * the main window while it is showing. A minimized or hidden window is never
 * brought back for it, so with no window showing the dialog stands alone
 * (window-conventions). */
function questionOwner(): BrowserWindow | undefined {
  const focused = BrowserWindow.getFocusedWindow()
  if (focused) return focused
  const main = mainWindow && !mainWindow.isDestroyed() ? mainWindow : null
  return main && main.isVisible() && !main.isMinimized() ? main : undefined
}

/** Focus the one owner window, or defer creation until stores/IPC/server are
 * ready. Both Dock activation and a second launch route here. */
function showOrCreateMainWindow(): void {
  if (!startupReady) return
  const existing = mainWindow && !mainWindow.isDestroyed() ? mainWindow : null
  if (!existing) {
    void createMainWindow().catch(handleTerminalStartupFailure)
    return
  }
  const win = existing
  if (win.isMinimized()) win.restore()
  if (!win.isVisible()) win.show()
  win.focus()
}

async function startup(): Promise<void> {
  await ensureDirs()
  const session = openRecords()
  onRecordStored(notifyRecordsChanged)
  initLogger({ debug: isDebugEnabled(app.isPackaged, process.env) })
  log.info('startup', {
    version: __APP_VERSION__,
    session,
    platform: process.platform,
    arch: process.arch,
  })
  // Clear what an interrupted managed-tool install left in temp/ once at launch,
  // before any install can start (paths.ts). It is optional startup cleanup, but
  // its diagnostic must remain visible in this launch's log.
  try {
    await sweepAbandonedStaging()
  } catch (error) {
    log.warn('temporary download staging could not be swept', { error: describeError(error) })
  }

  const configResult = await loadSettings()
  await applyLanguagePreference(getSettings().language)
  registerLanguageHandlers()
  // The saved theme reaches the title bar, the renderer's prefers-color-scheme,
  // and the recovery dialogs before any window exists, so launch never shows the
  // OS appearance and then switches. A failure before this point follows the OS.
  applyThemePreference(getSettings().theme)
  followOsThemeChanges()
  await loadDependencies()
  const sessionResult = await loadSession()
  await layout.loadLayout()

  await startMediaServer()
  registerIpcHandlers()
  registerDraftAnswers()
  queue.start()

  startupReady = true
  const initialWindow = await createMainWindow()

  // The just-in-case data backup (data-backup conventions) is write-through, not a
  // startup pass: every managed-text save records its exact bytes into
  // ~/.tapebox/backups.sqlite3 through a FIFO queue after its atomic rename lands (see
  // store/backupStore.ts and io/atomic-json.ts). There is nothing to kick off here.

  // If the library file was unreadable, it was set aside (never wiped); tell the
  // user at the app edge — the session store stays UI-free.
  if (sessionResult.status === 'recovered') {
    await notifyCorruptSession(sessionResult.quarantinePath, initialWindow)
  }
  if (configResult.status === 'recovered') {
    await notifyCorruptConfig(configResult.quarantinePath, initialWindow)
  } else if (configResult.status === 'loaded' && configResult.settingsKept) {
    await notifySettingsKept(paths.config, initialWindow)
  }
}

/** Every forced exit: the download tools TapeBox owns end with it, then the
 * process ends without entering cleanup a worker stuck in native I/O can stall. */
function exitNow(): void {
  killOwnedProcessesNow()
  forceExitProcess()
}

async function handleTerminalStartupFailure(error: unknown): Promise<void> {
  if (terminalStartupFailure) return
  terminalStartupFailure = true
  // Once the notice has been shown, nothing is left to save: the records worker
  // may be stuck in native I/O, so the exit is forced.
  await settleTerminalStartupFailure(error, {
    log,
    notify: notifyStartupFailure,
    exit: () => exitNow(),
  })
}

/** The quit's steps; quit.ts owns their order and bounds. Stopping work stops
 * downloads, tool installs, scans and other in-flight work, whose child
 * processes and library writes must not outlive the app; a download stopped
 * here resumes at the next launch. The media server is in-process, so it dies
 * with this process. */
const quit = createQuit({
  confirm: async (signal) => {
    const main = mainWindow && !mainWindow.isDestroyed() ? mainWindow : null
    if (!(await settleWindowDrafts(main, signal, askToDiscardDrafts, askAfterUnresponsiveWindow))) return false
    if (signal.aborted || !workIsRunning()) return true
    return askToStopWork(signal)
  },
  saveLibrary: () => persistNow({ quitting: true }),
  ask: askAfterFailedLibrarySave,
  // Cancel leaves the window as it was; only a main window that is gone comes back.
  resume: () => {
    resumeWork()
    resumeScans()
    resumeBinaryOperations()
    queue.resumeAfterQuit()
    if (startupReady && (!mainWindow || mainWindow.isDestroyed())) void createMainWindow().catch(handleTerminalStartupFailure)
  },
  stopWork: async () => {
    // The renderer can't report a final pause once we're tearing down.
    releaseWakeLock()
    log.info('shutdown')
    await Promise.all([shutdownBinaryOperations(), queue.shutdown(), cancelAllScans(), cancelAllWork()])
  },
  saveLayout: () => layout.persistNow(),
  close: async () => {
    await Promise.all([stopMediaServer(), closeBackupStore()])
    await closeRecordsReader()
    await closeRecords()
  },
  // The forced exit follows at once, so only the synchronous records drain can
  // still land the shutdown line.
  endNow: () => {
    log.info('shutdown', { reason: 'session-end' })
    flushRecordsBeforeExit()
  },
  warn: (message, details) => log.warn(message, details),
  exit: (forced) => {
    if (forced) { exitNow(); return }
    // Standalone version probes have no feature operation to stop them. Sweep
    // every remaining owned process after normal teardown, before terminal exit.
    killOwnedProcessesNow()
    app.exit(0)
  },
})

/** App-owned work quit would stop: downloads, tool installs, page scans and
 * user-started operations such as exports, imports and library moves. Queued
 * downloads are not running; they start again at the next launch. */
function workIsRunning(): boolean {
  return queue.hasActiveJobs() || hasInstalls() || hasActiveScans() || hasRunningWork()
}

async function askToStopWork(signal: AbortSignal): Promise<boolean> {
  const t = mainTranslator()
  const choice = await showPlainMessageDialog({
    owner: questionOwner(),
    language: t.language,
    title: t.t('quit.workRunning.title'),
    message: t.t('quit.workRunning.message'),
    detail: t.t('quit.workRunning.detail'),
    closeLabel: t.t('common.cancel'),
    actions: [{ id: 'quit', label: t.t('quit.workRunning.quit') }],
    signal,
  })
  return choice === 'quit'
}

/** Drafts in a minimized main window, asked about without bringing it back. */
async function askToDiscardDrafts(signal: AbortSignal): Promise<boolean> {
  const t = mainTranslator()
  const choice = await showPlainMessageDialog({
    owner: undefined,
    language: t.language,
    title: t.t('common.unsavedTitle'),
    message: t.t('common.unsavedMessage'),
    closeLabel: t.t('common.keepEditing'),
    actions: [{ id: 'discard', label: t.t('common.discard'), danger: true }],
    signal,
  })
  return choice === 'discard'
}

/** The main-owned fallback remains usable when the workspace cannot answer. */
async function askAfterUnresponsiveWindow(signal: AbortSignal): Promise<boolean> {
  const t = mainTranslator()
  const choice = await showPlainMessageDialog({
    owner: questionOwner(),
    language: t.language,
    title: 'TapeBox',
    message: t.t('quit.unresponsive.message'),
    closeLabel: t.t('common.cancel'),
    actions: [{ id: 'quit-anyway', label: t.t('quit.libraryNotSaved.quitAnyway'), danger: true }],
    signal,
  })
  return choice === 'quit-anyway'
}

async function askAfterFailedLibrarySave(signal: AbortSignal): Promise<QuitChoice> {
  const t = mainTranslator()
  const choice = await showPlainMessageDialog({
    // Above the window the user quit from, such as Records (window-conventions).
    owner: questionOwner(),
    language: t.language,
    title: t.t('quit.libraryNotSaved.title'),
    message: t.t('quit.libraryNotSaved.message'),
    detail: t.t('quit.libraryNotSaved.detail'),
    closeLabel: t.t('common.cancel'),
    actions: [
      { id: 'retry', label: t.t('common.tryAgain') },
      { id: 'quit-anyway', label: t.t('quit.libraryNotSaved.quitAnyway'), danger: true },
    ],
    signal,
  })
  return choice === 'retry' || choice === 'quit-anyway' ? choice : 'cancel'
}

// Global last-resort hooks. An uncaught exception is fatal: log it with full
// fidelity, drain the records synchronously so that line lands, then force the
// exit. The catalog keeps its last committed state (store/session.ts). An
// unhandled rejection is logged but not fatal — a stray fire-and-forget should
// not take a desktop app down, and a logged error at `error` level is a record,
// not a silent swallow. Every other way out closes the records itself: a quit
// through its close step, a forced exit without any cleanup at all.
process.on('uncaughtException', (err) => {
  log.error('uncaught exception', { error: describeError(err) })
  flushRecordsBeforeExit()
  exitNow()
})
process.on('unhandledRejection', (reason) => {
  log.error('unhandled rejection', { error: describeError(reason) })
})

void app.whenReady().then(() => {
  // Register before starting asynchronous initialization: macOS can deliver an
  // activation while stores/server/IPC are still loading. The handler defers;
  // startup creates the one owner window as soon as readiness is established.
  app.on('activate', showOrCreateMainWindow)
  // macOS and Linux: an OS logout, restart or shutdown, before its quit arrives.
  powerMonitor.on('shutdown', quit.markSessionEnd)
  // The computer's languages, the menu and AppKit's record of the choice, before
  // any window exists.
  void settleLanguageWhenReady().then(startup).catch(handleTerminalStartupFailure)
})

app.on('window-all-closed', () => {
  // No window means no <video>, so a playback wake lock is now stale. The app
  // ends with its windows on every platform; teardown belongs to the quit below.
  releaseWakeLock()
  app.quit()
})

app.on('before-quit', quit.beforeQuit)
