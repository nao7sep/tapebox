import { readFile } from 'node:fs/promises'
import { paths } from '@main/paths'
import { quarantineFile, writeManagedJson } from '@main/io/atomic-json'
import { log } from '@main/io/logger'
import { FORMAT_VERSION_KEY, FORMAT_VERSIONS, NewerFormatError, parseStoreJson } from '@main/io/format-version'
import { CollectionFolderSettingError, StoreAccessError } from '@main/io/store-access'
import { maskCredentials, maskYtdlpArgs } from '@main/io/mask'
import { tokenizeArgs } from '@main/services/ytdlp-args'
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
/** What config.json holds that this build cannot use: a set that failed its
 *  check, or a key it does not know. Each stays in the file exactly as written
 *  until the user saves that set; the session uses the built-in meanwhile
 *  (config-sets-conventions, Loading and fallback). */
let kept: Record<string, unknown> = {}

/** Sets whose failed copy needs no notice: a presentation preference, such as
 *  one a newer build added a value to, falls back harmlessly. */
const QUIET_SETS: ReadonlySet<string> = new Set(['theme', 'language'])

export async function loadSettings(): Promise<ConfigLoadResult> {
  const found = await readSettingsStore(paths.config)
  if (found !== null && 'sets' in found) {
    if (found.rejected.includes('libraryDir')) throw new CollectionFolderSettingError(paths.config)
    cache = effectiveSettings(found.sets)
    kept = found.kept
    const material = found.rejected.filter((key) => !QUIET_SETS.has(key))
    log.info('settings loaded', { config: loggedSettings(cache), kept: Object.keys(kept) })
    return { status: 'loaded', settingsKept: material.length > 0 }
  }
  kept = {}
  const defaults = defaultSettings()
  cache = defaults
  if (found === null) {
    log.info('settings missing; using built-ins', { config: loggedSettings(defaults) })
    return { status: 'missing' }
  }
  log.info('settings quarantined; using built-ins', { quarantinePath: found.quarantinePath })
  return { status: 'recovered', quarantinePath: found.quarantinePath }
}

/** The effective settings for the startup record, with any credential the yt-dlp
 *  arguments or the endpoint carry masked (io/mask.ts). */
function loggedSettings(settings: Settings): Record<string, unknown> {
  const credentials = [settings.ytdlpArgs, ...settings.siteProfiles.map((profile) => profile.args)]
    .flatMap((line) => maskYtdlpArgs(tokenizeArgs(line)).credentials)
  return maskCredentials(summarizeSettings(settings), credentials)
}

/** What loadSettings did, so the app edge can report a quarantine, or settings it
 *  kept but could not use, to the user (the store stays UI-free, mirroring the
 *  session store's recovery result). */
export type ConfigLoadResult =
  | { status: 'loaded'; settingsKept: boolean }
  | { status: 'missing' }
  | { status: 'recovered'; quarantinePath: string }

async function readSettingsStore(
  configPath: string,
): Promise<{ sets: SettingsSets; kept: Record<string, unknown>; rejected: string[] } | { quarantinePath: string } | null> {
  let text: string
  try {
    text = await readFile(configPath, 'utf8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw new StoreAccessError(configPath, err)
  }
  const found = parseStoreJson(text, FORMAT_VERSIONS.config)
  if (found.status === 'newer') throw new NewerFormatError(configPath, found.version, FORMAT_VERSIONS.config)
  if (found.status === 'unreadable') {
    log.warn('config unreadable; quarantining and falling back to defaults', { error: describeError(found.error) })
    return { quarantinePath: await quarantineFile(configPath) }
  }
  const { [FORMAT_VERSION_KEY]: _marker, ...written } = found.value
  const read = readSettingsSets(written)
  for (const key of read.rejected) log.warn('settings set invalid; kept in the file, using the built-in', { key })
  return read
}

export function getSettings(): Settings {
  if (!cache) throw new Error('config.ts: loadSettings() must be awaited first')
  return cache
}

/**
 * The resolved library directory every main consumer must use. An empty
 * libraryDir means "use the default", which resolves to paths.library; a set value is a custom folder used as-is. Routing all consumers
 * through this is what keeps a cleared Settings field from ever producing a
 * cwd-relative path (join('', file)) — see storage-path-conventions.
 */
export function getCollectionDir(): string {
  return getSettings().libraryDir || paths.library
}

// One serialized owner applies the cleaned patch to the cached settings and
// writes every set that differs from its built-in, beside what it kept. A result
// equal to what the file already holds writes nothing.
let writeChain: Promise<unknown> = Promise.resolve()

export function updateSettings(patch: SettingsSets): Promise<Settings> {
  const run = writeChain.then(async () => {
    const current = getSettings()
    const cleaned = StoredSettingsSchema.parse(cleanSettingsSets(patch))
    const next = storedSets({ ...current, ...cleaned })
    // A set the user saves replaces the copy kept for it; everything else kept
    // is written back exactly as it was read.
    const stillKept = Object.fromEntries(Object.entries(kept).filter(([key]) => !Object.hasOwn(cleaned, key)))
    if (JSON.stringify(next) !== JSON.stringify(storedSets(current)) || Object.keys(stillKept).length !== Object.keys(kept).length) {
      await writeManagedJson(paths.config, { ...next, ...stillKept }, { formatVersion: FORMAT_VERSIONS.config })
      log.info('settings updated', { keys: Object.keys(patch) })
    }
    // The in-memory view is authoritative only after the durable commit. A failed
    // save leaves every consumer on the last settings file that actually exists.
    kept = stillKept
    cache = effectiveSettings(next)
    return cache
  })
  // Keep the chain alive even if one update rejects, so a failed write can't wedge
  // every subsequent one.
  writeChain = run.then(() => undefined, () => undefined)
  return run
}
