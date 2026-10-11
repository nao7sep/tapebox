import { ipcMain, type BrowserWindow } from 'electron'
import { handle } from './ipc/handle'

/** macOS workspace close ends only the renderer's editing session. Let that
 * owner guard its drafts first. Quit/session end use app.exit and bypass this
 * close event entirely; Windows/Linux retain close-to-quit behavior. */
export function configureWindowClose(win: BrowserWindow, platform = process.platform): void {
  if (platform !== 'darwin') return
  let approved = false
  let requested = false
  win.on('close', (event) => {
    if (approved) return
    event.preventDefault()
    requested = true
    win.webContents.send('app:windowCloseRequested', null)
  })
  handle('app:closeWindow', (_request, event) => {
    // A different window, or an old renderer replaced after close, cannot
    // approve this window's destruction. No request means no permission.
    if (!requested || event.sender !== win.webContents || win.isDestroyed()) return
    requested = false
    approved = true
    try { win.close() } finally { approved = false }
  })
  win.once('closed', () => { ipcMain.removeHandler('app:closeWindow') })
}
