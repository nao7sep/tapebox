import { paths } from '@main/paths'
import { readJsonOptional, writeJsonAtomic } from '@main/io/atomic-json'
import { log } from '@main/io/logger'
import { SettingsSchema, defaultSettings, type Settings } from '@shared/settings'

/**
 * Config cache + atomic persistence for ~/.tapebox/config.json.
 *
 * On first launch, defaults are written to disk so the user has a config file
 * to inspect. Subsequent updates always re-validate via SettingsSchema before
 * persisting; an invalid update never reaches disk.
 *
 * NOTE: updateSettings does a SHALLOW merge. Callers patching nested objects
 * (e.g. binaries) must pass the full sub-object.
 */

let cache: Settings | null = null

export async function loadSettings(): Promise<void> {
  const found = await readJsonOptional(paths.config, SettingsSchema)
  if (found) {
    cache = found
    log.info('settings loaded')
  } else {
    cache = defaultSettings(paths.library)
    await writeJsonAtomic(paths.config, cache, SettingsSchema)
    log.info('settings not found; defaults written')
  }
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
