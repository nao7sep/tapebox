import { app, BrowserWindow, dialog, nativeTheme, shell } from 'electron'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ensureDirs } from './paths.js'
import { closeLogger, initLogger, isDebugEnabled, log } from './io/logger.js'
import { describeError } from '@shared/error'
import { loadSettings } from './store/config.js'
import { loadSession, persistNow, persistNowSync } from './store/session.js'
import * as layout from './store/layout.js'
import { registerIpcHandlers } from './ipc/index.js'
import * as queue from './queue/manager.js'
import { startMediaServer, stopMediaServer } from './media-server.js'
import { releaseWakeLock } from './power-blocker.js'
import { applyDevDockIcon, reassertDevDockIconAfterRepaint } from './dock-icon.js'

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
  const win = BrowserWindow.getAllWindows()[0]
  if (!win) return
  if (win.isMinimized()) win.restore()
  win.focus()
})

function createMainWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    show: false,
    backgroundColor: '#09090b',
    webPreferences: {
      preload: join(__dirname, '../preload/index.cjs'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      // Let the player's autoplay setting take effect without requiring a
      // per-load user gesture. Whether a tape actually autoplays is still
      // gated by the in-app setting (passed as <video autoPlay>).
      autoplayPolicy: 'no-user-gesture-required',
    },
  })

  // Open external links (About modal, etc.) in the OS browser, never a new
  // Electron window.
  win.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url)
    return { action: 'deny' }
  })

  // Leaving fullscreen (most often the player's native <video> fullscreen) un-hides
  // the macOS Dock and rebuilds its tile, dropping the dev icon overlay. Re-assert
  // it then — deferred, since that rebuild is async (see dock-icon.ts). Both events
  // are covered because video fullscreen can surface as window- or HTML-level; the
  // re-assert self-guards, so this is a no-op when packaged or off macOS.
  win.on('leave-full-screen', reassertDevDockIconAfterRepaint)
  win.webContents.on('leave-html-full-screen', reassertDevDockIconAfterRepaint)

  const devUrl = process.env['ELECTRON_RENDERER_URL']
  if (devUrl) {
    void win.loadURL(devUrl)
  } else {
    void win.loadFile(join(__dirname, '../renderer/index.html'))
  }

  win.once('ready-to-show', () => win.show())
  return win
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

  await loadSettings()
  const sessionResult = await loadSession()
  await layout.loadLayout()

  await startMediaServer()
  registerIpcHandlers()
  queue.start()

  // Force the native chrome — the window's title bar, menus, and native dialogs —
  // dark to match the renderer, which is a dark-only UI. Without this the title bar
  // follows the OS theme and looks pasted-on-light against the app's #09090b body.
  nativeTheme.themeSource = 'dark'
  createMainWindow()

  // Dev-only Dock icon overlay (macOS); no-op when packaged or off-macOS.
  applyDevDockIcon()

  // If the library file was unreadable, it was set aside (never wiped); tell the
  // user at the app edge — the session store stays UI-free.
  if (sessionResult.status === 'recovered') {
    notifyCorruptSession(sessionResult.quarantinePath)
  }
}

/**
 * Native error box (works before the renderer is ready) telling the user their
 * library file was corrupt and has been preserved, so an empty window is never a
 * silent surprise.
 */
function notifyCorruptSession(quarantinePath: string): void {
  dialog.showErrorBox(
    'Library could not be opened',
    'Your tapebox library file was unreadable and has been set aside so nothing is lost:\n\n' +
      `${quarantinePath}\n\n` +
      'tapebox has started with an empty library. Your downloaded media files are untouched.',
  )
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
    try {
      await persistNow()
    } catch {
      // already logged
    }
    await layout.persistNow()
    await stopMediaServer()
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
  void startup().catch((err) => {
    log.error('startup failed', { error: describeError(err) })
    app.quit()
  })

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createMainWindow()
    // macOS rebuilds the Dock tile on reactivation, dropping the dev overlay.
    applyDevDockIcon()
  })
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
