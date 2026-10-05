import { z } from 'zod'

/**
 * The managed-runtime-dependency facts — a distinct persisted KIND (app-recorded
 * facts, neither config the user authored nor view state they adjusted), so it
 * lives in its own dependencies.json with its own type, never folded into the
 * settings the user edits (persisted-store-separation-conventions). Splitting it
 * out is why a "reset settings" can't wipe the recorded check results and why an
 * update check churning these facts never rewrites the config file.
 *
 * Only what cannot be re-derived is stored, and both survivors are NETWORK facts
 * with no on-disk source: the last-known latest version and the last *successful*
 * check time. Presence is scanned from disk, and the INSTALLED version is read
 * from the artifact itself (binaries/installed-version.ts) — never persisted here,
 * because a fact about a file kept away from that file drifts the moment an install
 * doesn't write the record (one predating the tracking, an interrupted install, a
 * hand-placed binary, this file deleted to clear something else). Deleting this
 * store now costs the last check, not the installed version.
 *
 * No integrity flag, checksum, or check/fault error is kept either: a failed check
 * writes nothing, and a damaged file fails when used and is fixed by installing again.
 */
export const BinaryEntrySchema = z.object({
  latestKnownVersion: z.string().nullable(),
  lastCheckedAtUtc: z.string().nullable(),
})
export type BinaryEntry = z.infer<typeof BinaryEntrySchema>

/** A never-checked binary entry — the fresh-install default. */
export function freshBinaryEntry(): BinaryEntry {
  return {
    latestKnownVersion: null,
    lastCheckedAtUtc: null,
  }
}

/**
 * The recorded facts for every managed binary, keyed by name. The keys match the
 * registry (yt-dlp/ffmpeg/deno); the store keeps every one present so a consumer
 * reads `dependencies[name]` without a null guard. Beside them sits the one
 * app-wide time of the last check attempt, automatic or manual, written
 * immediately before the check starts; null until the first attempt.
 */
export const DependenciesSchema = z.object({
  'yt-dlp': BinaryEntrySchema,
  ffmpeg: BinaryEntrySchema,
  deno: BinaryEntrySchema,
  lastCheckAttemptAtUtc: z.string().nullable(),
})
export type Dependencies = z.infer<typeof DependenciesSchema>

/**
 * The fresh-install default: every binary never-checked. Unlike config, this is NOT
 * written to disk on first run — the file materializes lazily, only once a check or
 * install has an actual fact to record (the convention's "facts are written after
 * the app learns them"). A missing OR corrupt file self-heals to this in memory,
 * because every fact here is re-derivable and losing it costs only a re-check.
 */
export function defaultDependencies(): Dependencies {
  return {
    'yt-dlp': freshBinaryEntry(),
    ffmpeg:   freshBinaryEntry(),
    deno:     freshBinaryEntry(),
    lastCheckAttemptAtUtc: null,
  }
}

const DAY_MS = 24 * 60 * 60 * 1000
const UTC_ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/

/**
 * Whether the launch check runs: only when the last attempt time is missing,
 * invalid, in the future, or at least 24 hours old. The attempt, not a success,
 * is what counts, so a failed or offline check still waits a day.
 */
export function launchCheckDue(lastCheckAttemptAtUtc: string | null, nowMs: number): boolean {
  if (lastCheckAttemptAtUtc === null || !UTC_ISO.test(lastCheckAttemptAtUtc)) return true
  const attemptedMs = Date.parse(lastCheckAttemptAtUtc)
  return Number.isNaN(attemptedMs) || attemptedMs > nowMs || nowMs - attemptedMs >= DAY_MS
}
