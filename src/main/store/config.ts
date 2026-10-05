import { readFile } from 'node:fs/promises'
import { paths } from '@main/paths'
import { quarantineFile, writeManagedJson } from '@main/io/atomic-json'
import { log } from '@main/io/logger'
import { FORMAT_VERSIONS, NewerFormatError, parseStoreJson } from '@main/io/format-version'
import { describeError } from '@shared/error'
import {
  cleanSettingsSets, defaultSettings, effectiveSettings, storedSets, summarizeSettings, type Settings,
  type SettingsSets,
} from '@shared/settings'
import { StoredSettingsSchema, readSettingsSets } from './settings-sets'

/**
 * Effective settings cache and atomic persistence (config-sets-conventions).
 * The file is read once, at load; missing files and quarantined files use the
 * built-ins without seeding. Writes compute the stored sets from the cache
 * inside one serialized owner.
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

/** Read an explicit path, preserving corrupt bytes and resolving absent sets. A
 *  file in a newer format throws {@link NewerFormatError} and is left untouched. */
export async function readSettingsFile(
  configPath: string,
): Promise<{ settings: Settings } | { quarantinePath: string } | null> {
  const found = await readSettingsStore(configPath)
  return found !== null && 'sets' in found ? { settings: effectiveSettings(found.sets) } : found
}

async function readSettingsStore(
  configPath: string,
): Promise<{ sets: SettingsSets } | { quarantinePath: string } | null> {
  let text: string
  try {
    text = await readFile(configPath, 'utf8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null
    log.warn('config unreadable; quarantining and falling back to defaults', { error: describeError(err) })
    return { quarantinePath: await quarantineFile(configPath) }
  }
  const found = parseStoreJson(text, FORMAT_VERSIONS.config)
  if (found.status === 'newer') throw new NewerFormatError(configPath, found.version, FORMAT_VERSIONS.config)
  if (found.status === 'unreadable') {
    log.warn('config unreadable; quarantining and falling back to defaults', { error: describeError(found.error) })
    return { quarantinePath: await quarantineFile(configPath) }
  }
  return { sets: readSettingsSets(found.value, (key) => {
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

// One serialized owner applies the cleaned patch to the cached settings and
// writes every set that differs from its built-in. A result equal to what the
// cache already stores writes nothing.
let writeChain: Promise<unknown> = Promise.resolve()

export function updateSettings(patch: SettingsSets): Promise<Settings> {
  const run = writeChain.then(async () => {
    const current = getSettings()
    const next = storedSets({ ...current, ...StoredSettingsSchema.parse(cleanSettingsSets(patch)) })
    if (JSON.stringify(next) !== JSON.stringify(storedSets(current))) {
      await writeManagedJson(paths.config, next, { formatVersion: FORMAT_VERSIONS.config, schema: StoredSettingsSchema })
      log.info('settings updated', { keys: Object.keys(patch) })
    }
    // The in-memory view is authoritative only after the durable commit. A failed
    // save leaves every consumer on the last settings file that actually exists.
    cache = effectiveSettings(next)
    return cache
  })
  // Keep the chain alive even if one update rejects, so a failed write can't wedge
  // every subsequent one.
  writeChain = run.then(() => undefined, () => undefined)
  return run
}
