import { app, BrowserWindow, shell } from 'electron'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ensureDirs } from './paths.js'
import { closeLogger, initLogger, log, pruneOldLogs } from './io/logger.js'
import { loadSettings, getSettings } from './store/config.js'
import { loadSession, persistNow } from './store/session.js'
import * as layout from './store/layout.js'
import { registerIpcHandlers } from './ipc/index.js'
import * as queue from './queue/manager.js'
import { startMediaServer, stopMediaServer } from './media-server.js'

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
  const logPath = initLogger()
  log.info('startup', { logPath, platform: process.platform, arch: process.arch })

  await loadSettings()
  await pruneOldLogs(getSettings().retainLogCount)
  await loadSession()
  await layout.loadLayout()

  await startMediaServer()
  registerIpcHandlers()
  queue.start()
  createMainWindow()
}

/**
 * Idempotent teardown, run once on before-quit: flush session, stop the media
 * server, close the logger. The media server is in-process, so it dies with this
 * process — there is no separate server to leave stale.
 */
let shutdownPromise: Promise<void> | null = null
function shutdown(): Promise<void> {
  if (shutdownPromise) return shutdownPromise
  shutdownPromise = (async () => {
    try {
      await persistNow()
    } catch {
      // already logged
    }
    await layout.persistNow()
    await stopMediaServer()
    await closeLogger()
  })()
  return shutdownPromise
}

void app.whenReady().then(() => {
  void startup().catch((err) => {
    log.error('startup failed', { error: String(err) })
    app.quit()
  })

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createMainWindow()
  })
})

app.on('window-all-closed', () => {
  // macOS keeps the app (and its media server) alive in the dock for reactivation;
  // teardown belongs to the actual quit below. Other platforms quit on last close.
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', (event) => {
  if (shutdownPromise) return
  event.preventDefault()
  // finally (not then) so a teardown error still exits — quit must never hang.
  void shutdown().finally(() => app.exit(0))
})
