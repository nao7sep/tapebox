import { handle } from './handle'
import * as manager from '@main/binaries/manager'

type ActiveCheck = {
  controller: AbortController
  settled: Promise<void>
}

let activeCheck: ActiveCheck | null = null
let shuttingDown = false

export function registerBinaryHandlers(): void {
  handle('binaries:status', async () => manager.getAllStatuses())
  handle('binaries:update', async ({ name, operationId }) => manager.installOrUpdate(name, operationId))
  handle('binaries:cancelUpdate', async ({ name, operationId }) => manager.cancelInstall(name, operationId))
  handle('binaries:checkUpdates', async () => {
    if (shuttingDown) throw new Error('TapeBox is shutting down')
    if (activeCheck) throw new Error('Tool update check already in progress')
    const controller = new AbortController()
    const operation = manager.checkForUpdates(controller.signal)
    const active = {
      controller,
      settled: operation.then(() => undefined, () => undefined),
    }
    activeCheck = active
    try {
      return await operation
    } catch (err) {
      if (controller.signal.aborted) return { outcome: 'cancelled' }
      throw err
    } finally {
      if (activeCheck === active) activeCheck = null
    }
  })
  handle('binaries:cancelCheck', async () => {
    if (!activeCheck) return { outcome: 'not-running' }
    activeCheck.controller.abort(new DOMException('Tool update check cancelled', 'AbortError'))
    return { outcome: 'cancel-requested' }
  })
}

/** Application shutdown owns both acquisition and check cancellation. Join the
 * original operations so their terminal cleanup finishes before shared stores and
 * logging close. */
export async function shutdownBinaryOperations(): Promise<void> {
  shuttingDown = true
  const check = activeCheck
  if (check && !check.controller.signal.aborted) {
    check.controller.abort(new DOMException('TapeBox is shutting down', 'AbortError'))
  }
  await Promise.all([
    manager.shutdownInstalls(),
    check?.settled ?? Promise.resolve(),
  ])
}
