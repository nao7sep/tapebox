import { app, shell } from 'electron'
import { handle } from './handle'
import { getCurrentLogPath } from '@main/io/logger'
import { setVideoPlaying } from '@main/power-blocker'
import { isImportableUrl } from '@shared/url'

/**
 * Read-only facts about the current process, revealing this launch's log, and the
 * renderer's playback heartbeat that drives the keep-awake wake lock.
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

  handle('app:openExternal', async ({ url }) => {
    if (!isImportableUrl(url)) throw new Error('External URL scheme is not allowed')
    await shell.openExternal(url)
  })

  handle('app:setVideoPlaying', async ({ playing }) => {
    setVideoPlaying(playing)
  })
}
