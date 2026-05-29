import { handle } from './handle'
import * as config from '@main/store/config'
import * as apiKeys from '@main/services/api-keys'
import * as queue from '@main/queue/manager'

export function registerSettingsHandlers(): void {
  handle('settings:get', async () => config.getSettings())
  handle('settings:update', async (patch) => {
    const wasAutostart = config.getSettings().autoStartDownloads
    const next = await config.updateSettings(patch)
    // Flipping autostart on should start anything already waiting.
    if (!wasAutostart && next.autoStartDownloads) queue.resumePaused()
    return next
  })
  handle('settings:setApiKey', async ({ apiKey }) => {
    await apiKeys.writeAiKey(apiKey)
  })
  handle('settings:clearApiKey', async () => {
    await apiKeys.clearAiKey()
  })
  handle('settings:hasApiKey', async () => apiKeys.hasAiKey())
}
