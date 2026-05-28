import { handle } from './handle'
import * as config from '@main/store/config'

export function registerSettingsHandlers(): void {
  handle('settings:get', async () => config.getSettings())
  handle('settings:update', async (patch) => config.updateSettings(patch))
}
