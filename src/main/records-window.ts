import { app, BrowserWindow } from 'electron'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { RECORDS_WINDOW_MIN_HEIGHT, RECORDS_WINDOW_MIN_WIDTH } from '@shared/layout'
import { describeError } from '@shared/error'
import { log } from '@main/io/logger'
import { mainTranslator } from '@main/i18n'
import { windowBackground } from '@main/theme'
import { configureWindowActivity } from '@main/window-activity'
import { configureWindowMinimum } from '@main/window-minimum'
import { createWindowWithUsablePersistedBounds } from '@main/window-state-recovery'

const __dirname = dirname(fileURLToPath(import.meta.url))

/**
 * The Records window shows records.sqlite3. It is a durable secondary window
 * with its own placement (window-conventions, Placement), and there is only ever
 * one: opening it again brings it forward.
 */
let recordsWindow: BrowserWindow | null = null

export function recordsWindowOptions(
  title: string,
  preload: string,
  background: string,
): Electron.BrowserWindowConstructorOptions {
  return {
    name: 'records',
    windowStatePersistence: { bounds: true, displayMode: process.platform === 'win32' },
    title,
    width: 1240,
    height: 820,
    minWidth: RECORDS_WINDOW_MIN_WIDTH,
    minHeight: RECORDS_WINDOW_MIN_HEIGHT,
    show: false,
    backgroundColor: background,
    webPreferences: {
      preload,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
    },
  }
}

/** Tells the Records window, when it is open, that a record was stored. */
export function notifyRecordsChanged(): void {
  const window = recordsWindow
  if (window && !window.isDestroyed() && !window.webContents.isDestroyed()) {
    window.webContents.send('records:changed', null)
  }
}

export async function openRecordsWindow(): Promise<void> {
  const existing = recordsWindow
  if (existing && !existing.isDestroyed()) {
    if (existing.isMinimized()) existing.restore()
    existing.show()
    existing.focus()
    return
  }

  const options = recordsWindowOptions(
    mainTranslator().t('records.title'),
    join(__dirname, '../preload/index.cjs'),
    windowBackground(),
  )
  const window = createWindowWithUsablePersistedBounds('records', () => new BrowserWindow(options))
  recordsWindow = window
  window.once('closed', () => {
    if (recordsWindow === window) recordsWindow = null
  })
  configureWindowActivity(app, window)
  configureWindowMinimum(window, () => ({ width: RECORDS_WINDOW_MIN_WIDTH, height: RECORDS_WINDOW_MIN_HEIGHT }),
    (error) => log.warn('window minimum could not be updated', { window: 'records', error: describeError(error) }))
  // The page never navigates or opens a window of its own; a same-page reload
  // (a development full reload) is left alone.
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  window.webContents.on('will-navigate', (event, url) => {
    if (url !== window.webContents.getURL()) event.preventDefault()
  })
  window.once('ready-to-show', () => window.show())

  const devUrl = process.env['ELECTRON_RENDERER_URL']
  try {
    if (devUrl) await window.loadURL(`${devUrl}/records.html`)
    else await window.loadFile(join(__dirname, '../renderer/records.html'))
  } catch (error) {
    window.destroy()
    throw error
  }
}
