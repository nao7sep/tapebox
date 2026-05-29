import { app, BrowserWindow } from 'electron'
import { mkdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { requiredDirs } from './paths.js'
import { closeLogger, initLogger, log, pruneOldLogs } from './io/logger.js'
import { loadSettings, getSettings } from './store/config.js'
import { loadSession, persistNow } from './store/session.js'
import { registerIpcHandlers } from './ipc/index.js'
import * as queue from './queue/manager.js'
import { registerMediaProtocolHandler, registerMediaSchemeAsPrivileged } from './protocol.js'

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

// Privileged scheme registration must happen before app is ready.
registerMediaSchemeAsPrivileged()

async function ensureDirs(): Promise<void> {
  for (const dir of requiredDirs) {
    await mkdir(dir, { recursive: true })
  }
}

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
    },
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

  registerIpcHandlers()
  registerMediaProtocolHandler()
  queue.start()
  createMainWindow()
}

/**
 * Idempotent cleanup. Called from both window-all-closed (so macOS persists
 * on close without quitting) and before-quit (so explicit Cmd+Q persists too).
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
  void shutdown()
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', (event) => {
  if (shutdownPromise) return
  event.preventDefault()
  void shutdown().then(() => app.exit(0))
})
