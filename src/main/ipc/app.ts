import { shell } from 'electron'
import { handle } from './handle'
import { setVideoPlaying } from '@main/power-blocker'
import { isImportableUrl } from '@shared/url'

/**
 * Read-only facts about the current process, and the renderer's playback
 * heartbeat that drives the keep-awake wake lock.
 */
export function registerAppHandlers(): void {
  handle('app:runtimeInfo', async () => ({
    platform: process.platform,
    arch: process.arch,
    version: __APP_VERSION__,
  }))

  handle('app:openExternal', async ({ url }) => {
    if (!isImportableUrl(url)) throw new Error('External URL scheme is not allowed')
    await shell.openExternal(url)
  })

  handle('app:setVideoPlaying', async ({ playing }) => {
    setVideoPlaying(playing)
  })
}
