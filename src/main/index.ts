import { app, BrowserWindow } from 'electron'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { paths, requiredDirs } from './paths'
import { closeLogger, initLogger, log, pruneOldLogs } from './io/logger'
import { loadSettings, getSettings } from './store/config'
import { loadSession, persistNow } from './store/session'
import { registerIpcHandlers } from './ipc'

// Redirect Electron's own state into ~/.tapebox so everything lives in one
// place. Must happen before app is ready and before any path queries.
app.setPath('userData', paths.root)

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
      preload: join(__dirname, '../preload/index.js'),
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
  createMainWindow()
}

app.whenReady().then(() => {
  void startup().catch((err) => {
    log.error('startup failed', { error: String(err) })
    app.quit()
  })

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createMainWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', async (event) => {
  // Flush pending session writes and close the log file before exit.
  event.preventDefault()
  try {
    await persistNow()
  } catch {
    // already logged
  }
  await closeLogger()
  app.exit(0)
})
