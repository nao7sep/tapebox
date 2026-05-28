import { handle } from './handle'
import * as config from '@main/store/config'
import * as apiKeys from '@main/services/api-keys'

export function registerSettingsHandlers(): void {
  handle('settings:get', async () => config.getSettings())
  handle('settings:update', async (patch) => config.updateSettings(patch))
  handle('settings:setApiKey', async ({ profileId, apiKey }) => {
    await apiKeys.writeApiKey(profileId, apiKey)
  })
  handle('settings:clearApiKey', async ({ profileId }) => {
    await apiKeys.clearApiKey(profileId)
  })
}
