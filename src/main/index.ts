import { app, BrowserWindow, nativeTheme, shell } from 'electron'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ensureDirs, resetTempDir } from './paths.js'
import { notifyCorruptConfig, notifyCorruptSession, notifyStartupFailure } from './startup-dialog.js'
import { closeLogger, initLogger, isDebugEnabled, log } from './io/logger.js'
import { describeError } from '@shared/error'
import { loadSettings } from './store/config.js'
import { loadDependencies } from './store/dependencies.js'
import { loadSession, persistNow, persistNowSync } from './store/session.js'
import * as layout from './store/layout.js'
import { registerIpcHandlers } from './ipc/index.js'
import { shutdownBinaryOperations } from './ipc/binaries.js'
import * as queue from './queue/manager.js'
import { startMediaServer, stopMediaServer } from './media-server.js'
import { releaseWakeLock } from './power-blocker.js'
import { windowOptions } from './window-options.js'
import { closeBackupStore } from './store/backupStore.js'
import { isImportableUrl } from '@shared/url'
import { loadMainWindowContent } from './main-window-content.js'
import { settleTerminalStartupFailure } from './terminal-startup-failure.js'

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

let mainWindow: BrowserWindow | null = null
let startupReady = false
let terminalStartupFailure = false

async function createMainWindow(): Promise<BrowserWindow> {
  if (mainWindow && !mainWindow.isDestroyed()) return mainWindow
  const win = new BrowserWindow(windowOptions(join(__dirname, '../preload/index.cjs')))
  mainWindow = win
  win.once('closed', () => {
    if (mainWindow === win) mainWindow = null
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
    await loadMainWindowContent(win, devUrl, join(__dirname, '../renderer/index.html'))
  } catch (error) {
    log.error('main window document failed to load', { error: describeError(error) })
    // Keep the failed, never-shown owner alive until the terminal recovery
    // surface settles; destroying the last window can begin normal shutdown
    // before that surface is created.
    throw error
  }

  win.once('ready-to-show', () => win.show())
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
  const logPath = initLogger({ debug: isDebugEnabled(app.isPackaged, process.env) })
  log.info('startup', {
    version: app.getVersion(),
    logPath,
    platform: process.platform,
    arch: process.arch,
  })
  // Clear disposable download staging once at launch (a crash-interrupted
  // download must not leave a stale partial). It is optional startup cleanup,
  // but its diagnostic must remain visible in this launch's log.
  try {
    await resetTempDir()
  } catch (error) {
    log.warn('temporary download staging could not be reset', { error: describeError(error) })
  }

  const configResult = await loadSettings()
  await loadDependencies()
  const sessionResult = await loadSession()
  await layout.loadLayout()

  await startMediaServer()
  registerIpcHandlers()
  queue.start()

  // Force the native chrome — the window's title bar, menus, and native dialogs —
  // dark to match the renderer, which is a dark-only UI. Without this the title bar
  // follows the OS theme and looks pasted-on-light against the app's #09090b body.
  nativeTheme.themeSource = 'dark'
  startupReady = true
  const initialWindow = await createMainWindow()

  // The just-in-case data backup (data-backup conventions) is write-through, not a
  // startup pass: every managed-text save records its exact bytes into
  // ~/.tapebox/backups.sqlite3 through a FIFO queue after its atomic rename lands (see
  // store/backupStore.ts and io/atomic-json.ts). There is nothing to kick off here.

  // If the library file was unreadable, it was set aside (never wiped); tell the
  // user at the app edge — the session store stays UI-free.
  if (sessionResult.status === 'recovered') {
    await notifyCorruptSession(initialWindow)
  }
  if (configResult.status === 'recovered') {
    await notifyCorruptConfig(initialWindow)
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

/**
 * Idempotent teardown, run once on before-quit: flush session, stop the media
 * server, close the logger. The media server is in-process, so it dies with this
 * process — there is no separate server to leave stale.
 */
let shutdownPromise: Promise<void> | null = null
function shutdown(reason: string): Promise<void> {
  if (shutdownPromise) return shutdownPromise
  shutdownPromise = (async () => {
    log.info('shutdown', { reason })
    // The renderer can't report a final pause once we're tearing down, so drop any
    // held playback wake lock up front.
    releaseWakeLock()
    await shutdownBinaryOperations()
    try {
      await persistNow()
    } catch {
      // already logged
    }
    await layout.persistNow()
    await stopMediaServer()
    await closeBackupStore()
    closeLogger()
  })()
  return shutdownPromise
}

// Global last-resort hooks. An uncaught exception is fatal: log it with full
// fidelity, flush the file, then exit. An unhandled rejection is logged but not
// fatal — a stray fire-and-forget should not take a desktop app down, and a
// logged error at `error` level is a record, not a silent swallow. `exit` is a
// final synchronous flush for any path that bypasses the clean shutdown.
process.on('uncaughtException', (err) => {
  log.error('uncaught exception', { error: describeError(err) })
  persistNowSync()
  closeLogger()
  process.exit(1)
})
process.on('unhandledRejection', (reason) => {
  log.error('unhandled rejection', { error: describeError(reason) })
})
process.on('exit', () => {
  persistNowSync()
  closeLogger()
})

void app.whenReady().then(() => {
  // Register before starting asynchronous initialization: macOS can deliver an
  // activation while stores/server/IPC are still loading. The handler defers;
  // startup creates the one owner window as soon as readiness is established.
  app.on('activate', showOrCreateMainWindow)
  void startup().catch(handleTerminalStartupFailure)

})

app.on('window-all-closed', () => {
  // No window means no <video>, so a playback wake lock is now stale — release it
  // even on macOS, where the app (and its media server) lingers in the dock for
  // reactivation. Other platforms quit on last close; teardown belongs to the
  // actual quit below.
  releaseWakeLock()
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', (event) => {
  if (shutdownPromise) return
  event.preventDefault()
  // finally (not then) so a teardown error still exits — quit must never hang.
  void shutdown('before-quit').finally(() => app.exit(0))
})
