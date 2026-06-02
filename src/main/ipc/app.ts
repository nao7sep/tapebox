import { app } from 'electron'
import { handle } from './handle'

/**
 * Read-only facts about the current process.
 */
export function registerAppHandlers(): void {
  handle('app:runtimeInfo', async () => ({
    platform: process.platform,
    arch: process.arch,
    version: app.getVersion(),
  }))
}
