import { readFile } from 'node:fs/promises'
import { paths } from '@main/paths'
import { writeJsonAtomic } from '@main/io/atomic-json'
import { log } from '@main/io/logger'
import { describeError } from '@shared/error'
import { SettingsSchema, defaultSettings, summarizeSettings, type Settings } from '@shared/settings'

/**
 * Config cache + atomic persistence for ~/.tapebox/config.json.
 *
 * On first launch, defaults are written to disk so the user has a config file
 * to inspect. Subsequent updates always re-validate via SettingsSchema before
 * persisting; an invalid update never reaches disk.
 *
 * Load is self-healing: a missing OR unreadable/invalid config falls back to
 * defaults (and rewrites them). This holds only preferences — losing a corrupt
 * config file costs the user nothing, whereas crashing on boot costs everything.
 * Stores that hold real data (session, sidecars) fail loud instead.
 *
 * NOTE: updateSettings does a SHALLOW merge. Callers patching nested objects
 * (e.g. binaries) must pass the full sub-object.
 */

let cache: Settings | null = null

export async function loadSettings(): Promise<void> {
  const found = await readConfig()
  if (found) {
    cache = found
    log.info('settings loaded', { config: summarizeSettings(found) })
  } else {
    cache = defaultSettings(paths.library)
    await writeJsonAtomic(paths.config, cache, SettingsSchema)
    log.info('settings missing or invalid; defaults written', { config: summarizeSettings(cache) })
  }
}

async function readConfig(): Promise<Settings | null> {
  let raw: unknown
  try {
    raw = JSON.parse(await readFile(paths.config, 'utf8'))
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      log.warn('config unreadable; falling back to defaults', { error: describeError(err) })
    }
    return null
  }
  const parsed = SettingsSchema.safeParse(raw)
  if (parsed.success) return parsed.data
  log.warn('config invalid; falling back to defaults', { error: describeError(parsed.error) })
  return null
}

export function getSettings(): Settings {
  if (!cache) throw new Error('config.ts: loadSettings() must be awaited first')
  return cache
}

export async function updateSettings(patch: Partial<Settings>): Promise<Settings> {
  if (!cache) throw new Error('config.ts: loadSettings() must be awaited first')
  const merged = SettingsSchema.parse({ ...cache, ...patch })
  cache = merged
  await writeJsonAtomic(paths.config, merged, SettingsSchema)
  log.info('settings updated', { keys: Object.keys(patch) })
  return merged
}
