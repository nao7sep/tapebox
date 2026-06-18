import { chmod, stat } from 'node:fs/promises'
import { z } from 'zod'
import { paths } from '@main/paths'
import { readJsonOptional, writeJsonAtomic } from '@main/io/atomic-json'
import { log } from '@main/io/logger'

/**
 * Obfuscated API key storage with environment-first resolution.
 *
 * One file at ~/.tapebox/api-keys.json with a fixed 'ai' slot. Values use the
 * same lightweight local format as the other personal AI tools: "obf:" +
 * base64(reverse(key)). This is not encryption; it only avoids plain-text keys
 * during casual file browsing.
 *
 * Per the storage-path-conventions' secrets rule:
 *   - Resolution prefers the environment: OPENAI_API_KEY, when set and non-empty,
 *     wins over the stored value, so a user can supply a key without persisting
 *     it. The 'ai' slot speaks to an OpenAI-compatible endpoint, hence the name.
 *   - The file is written 0600 on POSIX (owner read/write only). On read, a file
 *     that is group/world-readable is warned about once and tightened back to
 *     0600 rather than refused, so an existing key never becomes unusable.
 */

const AI_SLOT = 'ai'
const API_KEY_MARKER = 'obf:'

// The environment variable that takes precedence over the stored 'ai' key.
const AI_ENV_VAR = 'OPENAI_API_KEY'

// Secrets file mode on POSIX; the permission model differs on Windows, where the
// check is skipped (storage-path-conventions).
const SECRETS_FILE_MODE = 0o600
const ENFORCE_FILE_MODE = process.platform !== 'win32'

let modeWarned = false

const SCHEMA = z.object({
  keys: z.record(z.string(), z.string()),
})
type ApiKeysFile = z.infer<typeof SCHEMA>

function envAiKey(): string | null {
  const value = process.env[AI_ENV_VAR]
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null
}

// POSIX-only: warn once if the secrets file is readable beyond the owner, and
// repair the mode opportunistically. The next write re-applies 0600 regardless.
async function warnIfInsecureMode(): Promise<void> {
  if (!ENFORCE_FILE_MODE || modeWarned) return
  try {
    const st = await stat(paths.apiKeys)
    if ((st.mode & 0o077) !== 0) {
      modeWarned = true
      log.warn('api key file is readable beyond the owner; tightening to 0600', {
        path: paths.apiKeys,
        mode: (st.mode & 0o777).toString(8).padStart(3, '0'),
      })
      await chmod(paths.apiKeys, SECRETS_FILE_MODE).catch(() => {})
    }
  } catch {
    // No file yet, or stat failed — nothing to warn about.
  }
}

async function readAll(): Promise<ApiKeysFile> {
  await warnIfInsecureMode()
  return (await readJsonOptional(paths.apiKeys, SCHEMA)) ?? { keys: {} }
}

function encodeApiKey(apiKey: string): string {
  if (!apiKey) return ''
  const reversed = Array.from(apiKey).reverse().join('')
  return `${API_KEY_MARKER}${Buffer.from(reversed, 'utf8').toString('base64')}`
}

function decodeApiKey(stored: string): string {
  if (!stored.startsWith(API_KEY_MARKER)) return ''
  try {
    const reversed = Buffer.from(stored.slice(API_KEY_MARKER.length), 'base64').toString('utf8')
    return Array.from(reversed).reverse().join('')
  } catch {
    return ''
  }
}

export async function readAiKey(): Promise<string | null> {
  // The environment value wins over the stored value.
  const fromEnv = envAiKey()
  if (fromEnv) return fromEnv
  const all = await readAll()
  const apiKey = decodeApiKey(all.keys[AI_SLOT] ?? '')
  return apiKey.length > 0 ? apiKey : null
}

export async function writeAiKey(apiKey: string): Promise<void> {
  const all = await readAll()
  all.keys[AI_SLOT] = encodeApiKey(apiKey)
  await writeJsonAtomic(paths.apiKeys, all, SCHEMA, SECRETS_FILE_MODE)
}

export async function clearAiKey(): Promise<void> {
  const all = await readAll()
  delete all.keys[AI_SLOT]
  await writeJsonAtomic(paths.apiKeys, all, SCHEMA, SECRETS_FILE_MODE)
}

export async function hasAiKey(): Promise<boolean> {
  if (envAiKey()) return true
  const all = await readAll()
  return decodeApiKey(all.keys[AI_SLOT] ?? '').length > 0
}
