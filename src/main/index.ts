import { app, BrowserWindow, powerMonitor, shell } from 'electron'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ensureDirs, sweepAbandonedStaging } from './paths.js'
import { notifyCorruptConfig, notifyCorruptSession, notifyStartupFailure } from './startup-dialog.js'
import { initLogger, isDebugEnabled, log } from './io/logger.js'
import { closeRecords, onRecordStored, openRecords } from './io/records.js'
import { closeRecordsReader } from './io/records-read.js'
import { notifyRecordsChanged } from './records-window.js'
import { describeError } from '@shared/error'
import { getSettings, loadSettings } from './store/config.js'
import { loadDependencies } from './store/dependencies.js'
import { loadSession, persistNow, persistNowSync } from './store/session.js'
import * as layout from './store/layout.js'
import { registerIpcHandlers } from './ipc/index.js'
import { shutdownBinaryOperations } from './ipc/binaries.js'
import * as queue from './queue/manager.js'
import { cancelAllScans } from './ipc/scan.js'
import { cancelAllWork } from './work-registry.js'
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
import { createQuit, type QuitChoice } from './quit.js'
import { showPlainMessageDialog } from './plain-message-dialog.js'
import { WINDOW_MIN_HEIGHT, WINDOW_MIN_WIDTH } from '@shared/layout'
import { BINARY_ACQUIRE_TIMEOUT_MS } from './io/network.js'
import {
  applyLanguagePreference,
  registerLanguageHandlers,
  mainTranslator,
  settleLanguageBeforeReady,
  settleLanguageWhenReady,
} from './i18n.js'

const __dirname = dirname(fileURLToPath(import.meta.url))

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

// The interface language is known before anything is drawn: Chromium's own
// strings take it from a switch that only applies before ready.
settleLanguageBeforeReady()

let mainWindow: BrowserWindow | null = null
let startupReady = false
let terminalStartupFailure = false

async function createMainWindow(): Promise<BrowserWindow> {
  if (mainWindow && !mainWindow.isDestroyed()) return mainWindow
  const options = windowOptions(join(__dirname, '../preload/index.cjs'), windowBackground())
  const win = createWindowWithUsablePersistedBounds('main', () => new BrowserWindow(options))
  mainWindow = win
  configureWindowActivity(app, win)
  configureWindowMinimum(win, () => ({ width: WINDOW_MIN_WIDTH, height: WINDOW_MIN_HEIGHT }),
    (error) => log.warn('window minimum could not be updated', { error: describeError(error) }))
  // Windows ends a logoff or shutdown here and never raises a quit event.
  win.on('session-end', quit.endSessionNow)
  win.once('closed', () => {
    if (mainWindow === win) mainWindow = null
    // The Records window beside it does not keep the app running: closing the
    // main window quits on Windows and Linux, and on macOS the Dock reopens it.
    if (process.platform !== 'darwin') app.quit()
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
  try {
    if (devUrl) await win.loadURL(devUrl)
    else await win.loadFile(join(__dirname, '../renderer/index.html'))
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
  // Sweep this host's crash-left download staging once at launch (a
  // crash-interrupted download must not leave a stale partial forever), proving
  // ownership by host+pid before removing anything (managed-runtime-dependencies-
  // conventions) rather than wiping the whole staging dir, which could delete
  // another host's in-flight download on a relocated/shared TAPEBOX_DATA_DIR. It is
  // optional startup cleanup, but its diagnostic must remain visible in this
  // launch's log.
  try {
    await sweepAbandonedStaging(BINARY_ACQUIRE_TIMEOUT_MS)
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
  }
}

async function handleTerminalStartupFailure(error: unknown): Promise<void> {
  if (terminalStartupFailure) return
  terminalStartupFailure = true
  await settleTerminalStartupFailure(error, {
    log,
    notify: notifyStartupFailure,
    exit: (code) => app.exit(code),
  })
}

/** The quit's steps; quit.ts owns their order and bounds. Stopping work stops
 * downloads, tool installs, scans and other in-flight work, whose child
 * processes and library writes must not outlive the app; a download stopped
 * here resumes at the next launch. The media server is in-process, so it dies
 * with this process. */
const quit = createQuit({
  saveLibrary: () => persistNow({ quitting: true }),
  ask: askAfterFailedLibrarySave,
  resume: showOrCreateMainWindow,
  stopWork: async () => {
    // The renderer can't report a final pause once we're tearing down.
    releaseWakeLock()
    log.info('shutdown')
    await Promise.all([shutdownBinaryOperations(), queue.shutdown(), cancelAllScans(), cancelAllWork()])
  },
  saveLayout: () => layout.persistNow(),
  close: async () => {
    await Promise.all([stopMediaServer(), closeBackupStore()])
    closeRecordsReader()
    closeRecords()
  },
  endNow: () => {
    log.info('shutdown', { reason: 'session-end' })
    persistNowSync()
    closeRecordsReader()
    closeRecords()
  },
  warn: (message, details) => log.warn(message, details),
  exit: () => app.exit(0),
})

async function askAfterFailedLibrarySave(signal: AbortSignal): Promise<QuitChoice> {
  const t = mainTranslator()
  const choice = await showPlainMessageDialog({
    owner: mainWindow && !mainWindow.isDestroyed() ? mainWindow : undefined,
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
// fidelity, close the records database, then exit. An unhandled rejection is
// logged but not fatal — a stray fire-and-forget should not take a desktop app
// down, and a logged error at `error` level is a record, not a silent swallow.
// `exit` is a final synchronous flush for any path that bypasses the clean
// shutdown.
process.on('uncaughtException', (err) => {
  log.error('uncaught exception', { error: describeError(err) })
  persistNowSync()
  closeRecords()
  process.exit(1)
})
process.on('unhandledRejection', (reason) => {
  log.error('unhandled rejection', { error: describeError(reason) })
})
process.on('exit', () => {
  persistNowSync()
  closeRecords()
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
  // No window means no <video>, so a playback wake lock is now stale — release it
  // even on macOS, where the app (and its media server) lingers in the dock for
  // reactivation. Other platforms quit on last close; teardown belongs to the
  // actual quit below.
  releaseWakeLock()
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', quit.beforeQuit)
