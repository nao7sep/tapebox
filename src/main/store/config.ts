import { readFile } from 'node:fs/promises'
import { paths } from '@main/paths'
import { writeJsonAtomic } from '@main/io/atomic-json'
import { log } from '@main/io/logger'
import { describeError } from '@shared/error'
import { SettingsSchema, defaultSettings, normalizeToolGates, summarizeSettings, type Settings } from '@shared/settings'

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
 * NOTE: updateSettings/mutateSettings do a SHALLOW merge of the returned patch.
 * A caller patching a nested object (e.g. binaries) must build the full sub-object
 * from the CURRENT settings — use mutateSettings, whose mutator receives the latest
 * cache inside a serialized critical section, so the read can never be stale.
 */

let cache: Settings | null = null

export async function loadSettings(): Promise<void> {
  const found = await readConfig()
  if (found) {
    cache = found
    log.info('settings loaded', { config: summarizeSettings(found) })
  } else {
    cache = defaultSettings()
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
  if (parsed.success) return normalizeToolGates(parsed.data)
  log.warn('config invalid; falling back to defaults', { error: describeError(parsed.error) })
  return null
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
    const merged = normalizeToolGates(SettingsSchema.parse({ ...cache, ...patch }))
    cache = merged
    await writeJsonAtomic(paths.config, merged, SettingsSchema)
    log.info('settings updated', { keys: Object.keys(patch) })
    return merged
  })
  // Keep the chain alive even if one update rejects, so a failed write can't wedge
  // every subsequent one.
  writeChain = run.then(() => undefined, () => undefined)
  return run
}
