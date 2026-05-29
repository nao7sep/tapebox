import { app, safeStorage } from 'electron'
import { handle } from './handle'

/**
 * Read-only facts about the current process. The renderer uses these to
 * gate UI affordances — e.g., hide "Save API key" with an inline banner
 * when OS keychain encryption is unavailable (typical bare Linux without
 * libsecret).
 */
export function registerAppHandlers(): void {
  handle('app:runtimeInfo', async () => ({
    platform: process.platform,
    arch: process.arch,
    encryptionAvailable: safeStorage.isEncryptionAvailable(),
    version: app.getVersion(),
  }))
}
