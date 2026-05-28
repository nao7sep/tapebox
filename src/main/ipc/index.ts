import { registerLibraryHandlers } from './library'
import { registerSettingsHandlers } from './settings'

/**
 * Mount all IPC handlers. Called once after stores are loaded and before
 * the renderer window is created.
 */
export function registerIpcHandlers(): void {
  registerLibraryHandlers()
  registerSettingsHandlers()
}
