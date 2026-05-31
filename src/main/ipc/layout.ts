import { handle } from './handle'
import * as layout from '@main/store/layout'

export function registerLayoutHandlers(): void {
  handle('layout:get', async () => layout.getLayout())
  handle('layout:update', async (patch) => layout.updateLayout(patch))
}
