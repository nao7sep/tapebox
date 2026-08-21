import { handle } from './handle'
import * as manager from '@main/binaries/manager'

let activeCheck: AbortController | null = null

export function registerBinaryHandlers(): void {
  handle('binaries:status', async () => manager.getAllStatuses())
  handle('binaries:update', async ({ name }) => manager.installOrUpdate(name))
  handle('binaries:cancelUpdate', async ({ name }) => manager.cancelInstall(name))
  handle('binaries:checkUpdates', async () => {
    if (activeCheck) throw new Error('Tool update check already in progress')
    const controller = new AbortController()
    activeCheck = controller
    try {
      return await manager.checkForUpdates(controller.signal)
    } catch (err) {
      if (controller.signal.aborted) return { outcome: 'cancelled' }
      throw err
    } finally {
      if (activeCheck === controller) activeCheck = null
    }
  })
  handle('binaries:cancelCheck', async () => {
    if (!activeCheck) return { outcome: 'not-running' }
    activeCheck.abort(new DOMException('Tool update check cancelled', 'AbortError'))
    return { outcome: 'cancel-requested' }
  })
}
