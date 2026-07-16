import { z } from 'zod'

/**
 * The managed-runtime-dependency facts — a distinct persisted KIND (app-recorded
 * facts, neither config the user authored nor view state they adjusted), so it
 * lives in its own dependencies.json with its own type, never folded into the
 * settings the user edits (persisted-store-separation-conventions). Splitting it
 * out is why a "reset settings" can't wipe the recorded install versions and why
 * an update check churning these facts never rewrites the config file.
 *
 * The per-binary shape is the single source of truth its status is derived from
 * (managed-runtime-dependencies-conventions): only what cannot be re-derived is
 * stored — the installed version, the last-known latest, and the last *successful*
 * check time. Presence is scanned from disk, not persisted. No integrity flag,
 * checksum, or check/fault error is kept: a failed check writes nothing, and a
 * damaged file fails when used and is fixed by installing again.
 *
 * `.strip()` drops any legacy fields from the old model (integrity, verifiedSha256,
 * checkError, faultError) on the next write, since the schema no longer lists them
 * (the app is pre-release; no migration code needed).
 */
export const BinaryEntrySchema = z
  .object({
    installedVersion: z.string().nullable(),
    latestKnownVersion: z.string().nullable(),
    lastCheckedAtUtc: z.string().nullable(),
  })
  .strip()
export type BinaryEntry = z.infer<typeof BinaryEntrySchema>

/** A never-installed, never-checked binary entry — the fresh-install default. */
export function freshBinaryEntry(): BinaryEntry {
  return {
    installedVersion: null,
    latestKnownVersion: null,
    lastCheckedAtUtc: null,
  }
}

/**
 * The recorded facts for every managed binary, keyed by name. The keys match the
 * registry (yt-dlp/ffmpeg/deno); the store keeps every one present so a consumer
 * reads `dependencies[name]` without a null guard, exactly as it read
 * `settings.binaries[name]` before the split.
 */
export const DependenciesSchema = z.object({
  'yt-dlp': BinaryEntrySchema,
  ffmpeg: BinaryEntrySchema,
  deno: BinaryEntrySchema,
})
export type Dependencies = z.infer<typeof DependenciesSchema>

/**
 * The fresh-install default: every binary never-installed, never-checked. Unlike
 * config, this is NOT written to disk on first run — the file materializes lazily,
 * only once a check or install has an actual fact to record (the convention's
 * "facts are written after the app learns them"). A missing OR corrupt file
 * self-heals to this in memory, because every fact here is re-derivable and losing
 * it costs only a re-check.
 */
export function defaultDependencies(): Dependencies {
  return {
    'yt-dlp': freshBinaryEntry(),
    ffmpeg:   freshBinaryEntry(),
    deno:     freshBinaryEntry(),
  }
}
