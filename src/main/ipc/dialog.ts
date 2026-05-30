import { BrowserWindow, dialog } from 'electron'
import { handle } from './handle'

export function registerDialogHandlers(): void {
  handle('dialog:pickDirectory', async ({ title }) => {
    const parent = BrowserWindow.getFocusedWindow() ?? undefined
    const result = parent
      ? await dialog.showOpenDialog(parent, {
          title,
          properties: ['openDirectory', 'createDirectory'],
        })
      : await dialog.showOpenDialog({
          title,
          properties: ['openDirectory', 'createDirectory'],
        })
    if (result.canceled || result.filePaths.length === 0) return null
    return result.filePaths[0] ?? null
  })

  handle('dialog:pickFiles', async ({ title }) => {
    const parent = BrowserWindow.getFocusedWindow() ?? undefined
    const filters = [
      { name: 'Media', extensions: ['webm', 'mp4', 'm4v', 'mkv', 'mov', 'm4a', 'mp3', 'opus', 'ogg'] },
      { name: 'All files', extensions: ['*'] },
    ]
    const result = parent
      ? await dialog.showOpenDialog(parent, { title, filters, properties: ['openFile', 'multiSelections'] })
      : await dialog.showOpenDialog({ title, filters, properties: ['openFile', 'multiSelections'] })
    if (result.canceled) return []
    return result.filePaths
  })
}
