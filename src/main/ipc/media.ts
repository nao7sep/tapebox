import { handle } from './handle'
import { getMediaBaseUrl } from '@main/media-server'

/**
 * Hands the renderer the base URL of the loopback media server. The renderer
 * fetches this once at startup and appends '/<encoded filename>' to play a
 * library file. The token lives inside this URL and travels only over IPC —
 * never through process argv — so it can't be read from `ps`.
 */
export function registerMediaHandlers(): void {
  handle('media:endpoint', async () => ({ baseUrl: getMediaBaseUrl() }))
}
