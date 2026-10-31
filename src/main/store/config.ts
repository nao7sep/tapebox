import { readFile } from 'node:fs/promises'
import { paths } from '@main/paths'
import { writeManagedJson } from '@main/io/atomic-json'
import { log } from '@main/io/logger'
import { FORMATS, parseStoreJson } from '@main/io/file-header'
import { CollectionFolderSettingError, RefusedFileError, StoreAccessError } from '@main/io/store-access'
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
 * The file is read once, at load; a missing file uses the built-ins without
 * seeding, and a refused one stops the launch. Writes compute the stored sets from the cache
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
  if (found !== null) {
    if (found.rejected.includes('collectionDir')) throw new CollectionFolderSettingError(paths.config)
    cache = effectiveSettings(found.sets)
    kept = found.kept
    const material = found.rejected.filter((key) => !QUIET_SETS.has(key))
    log.info('settings loaded', { config: loggedSettings(cache), kept: Object.keys(kept) })
    return { status: 'loaded', settingsKept: material.length > 0 }
  }
  kept = {}
  const defaults = defaultSettings()
  cache = defaults
  log.info('settings missing; using built-ins', { config: loggedSettings(defaults) })
  return { status: 'missing' }
}

/** The effective settings for the startup record, with any credential the yt-dlp
 *  arguments or the endpoint carry masked (io/mask.ts). */
function loggedSettings(settings: Settings): Record<string, unknown> {
  const credentials = [settings.ytdlpArgs, ...settings.siteProfiles.map((profile) => profile.args)]
    .flatMap((line) => maskYtdlpArgs(tokenizeArgs(line)).credentials)
  return maskCredentials(summarizeSettings(settings), credentials)
}

/** What loadSettings did, so the app edge can report settings it kept but
 *  could not use to the user (the store stays UI-free). A config.json that is
 *  newer or unreadable is refused with {@link RefusedFileError} and stops the
 *  launch, left exactly as it is (store-recovery-conventions). */
export type ConfigLoadResult =
  | { status: 'loaded'; settingsKept: boolean }
  | { status: 'missing' }

async function readSettingsStore(
  configPath: string,
): Promise<{ sets: SettingsSets; kept: Record<string, unknown>; rejected: string[] } | null> {
  let text: string
  try {
    text = await readFile(configPath, 'utf8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw new StoreAccessError(configPath, err)
  }
  const found = parseStoreJson(text, FORMATS.config)
  if (found.status === 'newer') throw new RefusedFileError(configPath, 'newer')
  if (found.status === 'unreadable') {
    log.warn('config unreadable; left as it is', { error: describeError(found.error) })
    throw new RefusedFileError(configPath, 'unreadable', found.error)
  }
  const read = readSettingsSets(found.value)
  for (const key of read.rejected) log.warn('settings set invalid; kept in the file, using the built-in', { key })
  return read
}

export function getSettings(): Settings {
  if (!cache) throw new Error('config.ts: loadSettings() must be awaited first')
  return cache
}

/**
 * The resolved collection directory every main consumer must use. An empty
 * collectionDir means "use the default", which resolves to paths.collection; a set value is a custom folder used as-is. Routing all consumers
 * through this is what keeps a cleared Settings field from ever producing a
 * cwd-relative path (join('', file)) — see storage-path-conventions.
 */
export function getCollectionDir(): string {
  return getSettings().collectionDir || paths.collection
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
      await writeManagedJson(paths.config, { ...next, ...stillKept }, { format: FORMATS.config })
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
