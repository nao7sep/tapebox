import { registerLibraryHandlers } from './library'
import { registerSettingsHandlers } from './settings'
import { registerBinaryHandlers } from './binaries'
import { registerDownloadHandlers } from './downloads'
import { registerEnumHandlers } from './enum'
import { registerAiHandlers } from './ai'
import { registerExportHandlers } from './export'
import { registerDialogHandlers } from './dialog'
import { registerAppHandlers } from './app'

/**
 * Mount all IPC handlers. Called once after stores are loaded and before
 * the renderer window is created.
 */
export function registerIpcHandlers(): void {
  registerLibraryHandlers()
  registerSettingsHandlers()
  registerBinaryHandlers()
  registerDownloadHandlers()
  registerEnumHandlers()
  registerAiHandlers()
  registerExportHandlers()
  registerDialogHandlers()
  registerAppHandlers()
}
