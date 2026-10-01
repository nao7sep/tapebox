import { readFile } from 'node:fs/promises'
import { paths } from '@main/paths'
import { quarantineFile, writeManagedJson } from '@main/io/atomic-json'
import { log } from '@main/io/logger'
import { describeError } from '@shared/error'
import {
  SettingsSchema, SettingsPatchSchema, defaultSettings, effectiveSettings, readSettingsSets,
  summarizeSettings, type Settings, type SettingsPatch, type SettingsSets,
} from '@shared/settings'

/**
 * Effective settings cache and atomic persistence. Only user-written sets live
 * on disk; missing files and quarantined files use the built-ins without seeding.
 * Writes reread the current map inside the serialized owner and replace only the
 * requested sets, so untouched settings never become stored defaults.
 */

let cache: Settings | null = null

export async function loadSettings(): Promise<ConfigLoadResult> {
  const found = await readSettingsStore(paths.config)
  if (found !== null && 'sets' in found) {
    cache = effectiveSettings(found.sets)
    log.info('settings loaded', { config: summarizeSettings(cache) })
    return { status: 'loaded' }
  }
  const defaults = defaultSettings()
  cache = defaults
  if (found === null) {
    log.info('settings missing; using built-ins', { config: summarizeSettings(defaults) })
    return { status: 'missing' }
  }
  log.info('settings quarantined; using built-ins', { quarantinePath: found.quarantinePath })
  return { status: 'recovered', quarantinePath: found.quarantinePath }
}

/** What loadSettings did, so the app edge can report a quarantine to the user
 *  (the store stays UI-free, mirroring the session store's recovery result). */
export type ConfigLoadResult =
  | { status: 'loaded' }
  | { status: 'missing' }
  | { status: 'recovered'; quarantinePath: string }

/** Read an explicit path, preserving corrupt bytes and resolving absent sets. */
export async function readSettingsFile(
  configPath: string,
): Promise<{ settings: Settings } | { quarantinePath: string } | null> {
  const found = await readSettingsStore(configPath)
  return found !== null && 'sets' in found ? { settings: effectiveSettings(found.sets) } : found
}

const warnedInvalidKeys = new Set<keyof Settings>()

async function readSettingsStore(
  configPath: string,
): Promise<{ sets: SettingsSets } | { quarantinePath: string } | null> {
  let raw: unknown
  try {
    raw = JSON.parse(await readFile(configPath, 'utf8'))
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null
    log.warn('config unreadable; quarantining and falling back to defaults', { error: describeError(err) })
    return { quarantinePath: await quarantineFile(configPath) }
  }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    log.warn('config invalid; quarantining and falling back to defaults')
    return { quarantinePath: await quarantineFile(configPath) }
  }
  return { sets: readSettingsSets(raw as Record<string, unknown>, (key) => {
    if (warnedInvalidKeys.has(key)) return
    warnedInvalidKeys.add(key)
    log.warn('settings set invalid; using built-in', { key })
  }) }
}

export function getSettings(): Settings {
  if (!cache) throw new Error('config.ts: loadSettings() must be awaited first')
  return cache
}

/**
 * The resolved library directory every main consumer must use. An empty (or
 * whitespace-only) libraryDir means "use the default", which resolves to
 * paths.library; a set value is a custom folder used as-is. Routing all consumers
 * through this is what keeps a cleared Settings field from ever producing a
 * cwd-relative path (join('', file)) — see storage-path-conventions.
 */
export function getLibraryDir(): string {
  return getSettings().libraryDir.trim() || paths.library
}

// One serialized owner rereads the on-disk map before every set write.
let writeChain: Promise<unknown> = Promise.resolve()

export function updateSettings(patch: SettingsPatch): Promise<Settings> {
  const run = writeChain.then(async () => {
    if (!cache) throw new Error('config.ts: loadSettings() must be awaited first')
    const found = await readSettingsStore(paths.config)
    const sets = found !== null && 'sets' in found ? found.sets : {}
    const validated = SettingsPatchSchema.parse(patch)
    if (Object.keys(validated).length === 0) return cache
    for (const [key, value] of Object.entries(validated)) {
      if (value === undefined) continue
      if (value === null) delete sets[key as keyof Settings]
      else Object.assign(sets, { [key]: value })
    }
    await writeManagedJson(paths.config, sets, SettingsSchema)
    const merged = effectiveSettings(sets)
    // The in-memory view is authoritative only after the durable commit. A failed
    // save leaves every consumer on the last settings file that actually exists.
    cache = merged
    log.info('settings updated', { keys: Object.keys(patch) })
    return merged
  })
  // Keep the chain alive even if one update rejects, so a failed write can't wedge
  // every subsequent one.
  writeChain = run.then(() => undefined, () => undefined)
  return run
}
