import { z } from 'zod'
import { paths } from '@main/paths'
import { readJsonOptional, writeJsonAtomic } from '@main/io/atomic-json'

/**
 * Obfuscated API key storage.
 *
 * One file at ~/.tapebox/api-keys.json with a fixed 'ai' slot. Values use the
 * same lightweight local format as the other personal AI tools: "obf:" +
 * base64(reverse(key)). This is not encryption; it only avoids plain-text keys
 * during casual file browsing.
 */

const AI_SLOT = 'ai'
const API_KEY_MARKER = 'obf:'

const SCHEMA = z.object({
  keys: z.record(z.string(), z.string()),
})
type ApiKeysFile = z.infer<typeof SCHEMA>

async function readAll(): Promise<ApiKeysFile> {
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
  const all = await readAll()
  const apiKey = decodeApiKey(all.keys[AI_SLOT] ?? '')
  return apiKey.length > 0 ? apiKey : null
}

export async function writeAiKey(apiKey: string): Promise<void> {
  const all = await readAll()
  all.keys[AI_SLOT] = encodeApiKey(apiKey)
  await writeJsonAtomic(paths.apiKeys, all, SCHEMA)
}

export async function clearAiKey(): Promise<void> {
  const all = await readAll()
  delete all.keys[AI_SLOT]
  await writeJsonAtomic(paths.apiKeys, all, SCHEMA)
}

export async function hasAiKey(): Promise<boolean> {
  const all = await readAll()
  return decodeApiKey(all.keys[AI_SLOT] ?? '').length > 0
}
