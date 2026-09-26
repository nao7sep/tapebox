import { BrowserWindow, dialog } from 'electron'
import { handle } from './handle'
import { mainTranslator } from '@main/i18n'

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
    // Import is sidecar-driven: the user picks the .json sidecars and each names its
    // own media + thumbnail, which the importer reads from beside it.
    const t = mainTranslator()
    const filters = [
      { name: t.t('dialog.sidecarFilter'), extensions: ['json'] },
      { name: t.t('dialog.allFilesFilter'), extensions: ['*'] },
    ]
    const result = parent
      ? await dialog.showOpenDialog(parent, { title, filters, properties: ['openFile', 'multiSelections'] })
      : await dialog.showOpenDialog({ title, filters, properties: ['openFile', 'multiSelections'] })
    if (result.canceled) return []
    return result.filePaths
  })
}
