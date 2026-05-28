import { safeStorage } from 'electron'
import { z } from 'zod'
import { paths } from '@main/paths'
import { readJsonOptional, writeJsonAtomic } from '@main/io/atomic-json'

/**
 * Encrypted API key storage.
 *
 * One file at ~/.tapebox/api-keys.json keyed by profile id. Values are
 * base64-encoded safeStorage ciphertexts (Keychain on macOS, DPAPI on Windows,
 * libsecret on Linux). The plain key text never lands on disk.
 *
 * Failure modes worth knowing:
 *   - safeStorage.isEncryptionAvailable() returns false on some Linux systems
 *     without libsecret. We surface that as a clear error to the renderer.
 *   - If the OS keychain entry changes (machine swap, profile reset), stored
 *     blobs decrypt to garbage. Clear and re-enter the key.
 */

const SCHEMA = z.object({
  schemaVersion: z.literal(1),
  keys: z.record(z.string(), z.string()),
})
type ApiKeysFile = z.infer<typeof SCHEMA>

async function readAll(): Promise<ApiKeysFile> {
  return (await readJsonOptional(paths.apiKeys, SCHEMA)) ?? { schemaVersion: 1, keys: {} }
}

function requireEncryption(): void {
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error('OS keychain encryption is unavailable on this system')
  }
}

export async function readApiKey(profileId: string): Promise<string | null> {
  requireEncryption()
  const all = await readAll()
  const blob = all.keys[profileId]
  if (!blob) return null
  return safeStorage.decryptString(Buffer.from(blob, 'base64'))
}

export async function writeApiKey(profileId: string, apiKey: string): Promise<void> {
  requireEncryption()
  const all = await readAll()
  const encrypted = safeStorage.encryptString(apiKey).toString('base64')
  all.keys[profileId] = encrypted
  await writeJsonAtomic(paths.apiKeys, all, SCHEMA)
}

export async function clearApiKey(profileId: string): Promise<void> {
  const all = await readAll()
  delete all.keys[profileId]
  await writeJsonAtomic(paths.apiKeys, all, SCHEMA)
}
