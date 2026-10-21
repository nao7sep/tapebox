import { stat } from 'node:fs/promises'
import { dirname } from 'node:path'
import { normalizeUserDir } from '@main/core/user-directory'
import { BrowserWindow, dialog } from 'electron'
import { handle } from './handle'
import { mainTranslator } from '@main/i18n'

/** A picker sits above the window that asked for it (window-conventions). */
function requestingWindow(sender: Electron.WebContents): BrowserWindow | undefined {
  const window = BrowserWindow.fromWebContents(sender)
  return window && !window.isDestroyed() ? window : undefined
}

/** A missing folder opens at its nearest usable ancestor without creating it. */
async function pickerDirectory(value: string | undefined): Promise<string | undefined> {
  if (!value) return undefined
  let directory: string
  try {
    directory = normalizeUserDir('errors.exportFolderNotAbsolute', value)
  } catch {
    // Invalid drafts stay editable; they are not relative filesystem locations.
    return undefined
  }
  while (directory) {
    try {
      if ((await stat(directory)).isDirectory()) return directory
    } catch {
      // Missing or inaccessible locations can still have a usable parent.
    }
    const parent = dirname(directory)
    if (parent === directory) return undefined
    directory = parent
  }
  return undefined
}

export function registerDialogHandlers(): void {
  handle('dialog:pickDirectory', async ({ title, initialDirectory }, event) => {
    const defaultPath = await pickerDirectory(initialDirectory)
    const parent = requestingWindow(event.sender)
    const result = parent
      ? await dialog.showOpenDialog(parent, {
          title,
          ...(defaultPath ? { defaultPath } : {}),
          properties: ['openDirectory', 'createDirectory'],
        })
      : await dialog.showOpenDialog({
          title,
          ...(defaultPath ? { defaultPath } : {}),
          properties: ['openDirectory', 'createDirectory'],
        })
    if (result.canceled || result.filePaths.length === 0) return null
    return result.filePaths[0] ?? null
  })

  handle('dialog:pickFiles', async ({ title }, event) => {
    const parent = requestingWindow(event.sender)
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
