import { readFile, rename } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { paths } from '@main/paths'
import { writeManagedJson } from '@main/io/atomic-json'
import { log } from '@main/io/logger'
import { describeError } from '@shared/error'
import { utcTimestampForFilenameMs } from '@shared/utc'
import { SettingsSchema, defaultSettings, summarizeSettings, type Settings } from '@shared/settings'

/**
 * Config cache + atomic persistence for ~/.tapebox/config.json.
 *
 * On first launch, defaults are written to disk so the user has a config file
 * to inspect. Subsequent updates always re-validate via SettingsSchema before
 * persisting; an invalid update never reaches disk.
 *
 * Load is self-healing but never destructive: a missing config falls back to
 * defaults (written out); a present-but-corrupt config (unreadable or schema-
 * invalid) is quarantined aside to `config-<stamp>.invalid` before defaults
 * are written, so the user's bytes are preserved rather than silently discarded —
 * the storage-path conventions' quarantine-then-reset rule (mirrors the session
 * store's catalog quarantine). These are only preferences, so recovering with
 * defaults beats crashing on boot; stores that hold real data still fail loud.
 *
 * NOTE: updateSettings/mutateSettings do a SHALLOW merge of the returned patch.
 * A caller patching a nested object (e.g. binaries) must build the full sub-object
 * from the CURRENT settings — use mutateSettings, whose mutator receives the latest
 * cache inside a serialized critical section, so the read can never be stale.
 */

let cache: Settings | null = null

export async function loadSettings(): Promise<void> {
  const found = await readSettingsFile(paths.config)
  if (found) {
    cache = found
    log.info('settings loaded', { config: summarizeSettings(found) })
  } else {
    cache = defaultSettings()
    await writeManagedJson(paths.config, cache, SettingsSchema)
    log.info('settings missing or invalid; defaults written', { config: summarizeSettings(cache) })
  }
}

/**
 * Load settings from an explicit path — the path-taking seam the app singleton wraps (mirrors
 * loadSessionFile). Returns the parsed settings, or null when the file is missing OR was corrupt. A
 * present-but-corrupt file is quarantined aside before null is returned, so the caller's reseed never
 * discards the user's bytes; a missing file returns null with nothing to preserve.
 */
export async function readSettingsFile(configPath: string): Promise<Settings | null> {
  let raw: unknown
  try {
    raw = JSON.parse(await readFile(configPath, 'utf8'))
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null
    log.warn('config unreadable; quarantining and falling back to defaults', { error: describeError(err) })
    await quarantineCorruptConfig(configPath)
    return null
  }
  const parsed = SettingsSchema.safeParse(raw)
  if (parsed.success) return parsed.data
  log.warn('config invalid; quarantining and falling back to defaults', { error: describeError(parsed.error) })
  await quarantineCorruptConfig(configPath)
  return null
}

// Rename a corrupt config aside to a timestamped `config-<stamp>.invalid` neighbour before the
// caller reseeds defaults over the path — best-effort (a rename failure is logged, not fatal).
async function quarantineCorruptConfig(configPath: string): Promise<void> {
  const quarantinePath = join(dirname(configPath), `config-${utcTimestampForFilenameMs()}.invalid`)
  try {
    await rename(configPath, quarantinePath)
    log.warn('quarantined corrupt config', { quarantinePath })
  } catch (err) {
    log.error('failed to quarantine corrupt config', { error: describeError(err) })
  }
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

// Serializes all settings writes so two concurrent read-modify-write callers (e.g.
// the startup update-check racing a user-clicked Install) can't clobber each other's
// nested patches with a stale snapshot.
let writeChain: Promise<unknown> = Promise.resolve()

export function updateSettings(patch: Partial<Settings>): Promise<Settings> {
  return mutateSettings(() => patch)
}

/**
 * Atomically read-modify-write settings. The mutator runs inside a serialized
 * critical section against the *current* cache, so a caller patching a nested object
 * (e.g. binaries) always reads the latest sibling fields and never overwrites a
 * concurrent write with a value snapshotted before it.
 */
export function mutateSettings(
  mutator: (current: Settings) => Partial<Settings>,
): Promise<Settings> {
  const run = writeChain.then(async () => {
    if (!cache) throw new Error('config.ts: loadSettings() must be awaited first')
    const patch = mutator(cache)
    const merged = SettingsSchema.parse({ ...cache, ...patch })
    cache = merged
    await writeManagedJson(paths.config, merged, SettingsSchema)
    log.info('settings updated', { keys: Object.keys(patch) })
    return merged
  })
  // Keep the chain alive even if one update rejects, so a failed write can't wedge
  // every subsequent one.
  writeChain = run.then(() => undefined, () => undefined)
  return run
}
