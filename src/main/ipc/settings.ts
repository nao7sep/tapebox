import { handle } from './handle'
import * as config from '@main/store/config'
import * as apiKeys from '@main/services/api-keys'
import * as queue from '@main/queue/manager'
import { reconcileWakeLock } from '@main/power-blocker'

export function registerSettingsHandlers(): void {
  handle('settings:get', async () => config.getSettings())
  handle('settings:update', async (patch) => {
    const wasAutostart = config.getSettings().autoStartDownloads
    const next = await config.updateSettings(patch)
    // Flipping autostart on should start anything already waiting.
    if (!wasAutostart && next.autoStartDownloads) queue.resumePaused()
    // Toggling keep-awake off mid-playback must release the held wake lock now
    // (and toggling it on while a tape plays must acquire it) — reconcile against
    // the new setting rather than waiting for the next play/pause transition.
    reconcileWakeLock()
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
