import { app, shell } from 'electron'
import { handle } from './handle'
import { getCurrentLogPath } from '@main/io/logger'

/**
 * Read-only facts about the current process, plus revealing this launch's log.
 */
export function registerAppHandlers(): void {
  handle('app:runtimeInfo', async () => ({
    platform: process.platform,
    arch: process.arch,
    version: app.getVersion(),
  }))

  handle('app:revealLog', async () => {
    const path = getCurrentLogPath()
    if (path) shell.showItemInFolder(path)
  })
}
