import { handle } from './handle'
import * as manager from '@main/binaries/manager'

export function registerBinaryHandlers(): void {
  handle('binaries:status', async () => manager.getAllStatuses())
  handle('binaries:update', async ({ name }) => manager.installOrUpdate(name))
  handle('binaries:cancelUpdate', async ({ name }) => manager.cancelInstall(name))
  handle('binaries:checkUpdates', async () => manager.checkForUpdates())
}
