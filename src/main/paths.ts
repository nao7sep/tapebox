import { homedir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'
import { chmod, mkdir, readdir, rm, stat } from 'node:fs/promises'

/**
 * All TapeBox app state lives under ~/.tapebox by convention — this is our own
 * data only. Electron/Chromium state (cache, cookies, GPU cache, etc.) is left
 * in the OS-default userData location and never mixed in here.
 *
 * 'temp' is our own disposable staging for managed-tool installs in progress —
 * it holds nothing precious and is cleared on launch (an interrupted install
 * leaves no stale partial). Downloaded videos never stage here. It is
 * deliberately named 'temp', not 'downloads' (which would read as retained user
 * data), per the managed-runtime-dependencies-conventions.
 *
 * The storage root is relocatable wholesale via TAPEBOX_DATA_DIR (storage-path-
 * conventions). When that variable is set and non-empty, its value — with a
 * leading `~`/`~/` and `$VAR`/`%VAR%` references expanded, then made absolute
 * against the HOME directory (never process.cwd()) — is the root; otherwise the
 * root is the default `<home>/.tapebox`. An override that cannot be made into a
 * usable absolute path is a startup error, not a silent fallback. The resolution
 * mirrors mumbler's reference implementation.
 */

// Expand `$VAR` / `${VAR}` (POSIX) and `%VAR%` (Windows) references against the
// current environment. An undefined reference expands to empty, matching shell
// behavior, rather than being left as a literal that would become a path segment.
function expandEnvReferences(value: string): string {
  return value
    .replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_m, name: string) => process.env[name] ?? '')
    .replace(/\$([A-Za-z_][A-Za-z0-9_]*)/g, (_m, name: string) => process.env[name] ?? '')
    .replace(/%([A-Za-z_][A-Za-z0-9_]*)%/g, (_m, name: string) => process.env[name] ?? '')
}

/**
 * Resolve the storage root per the storage-path-conventions. Pure and
 * home-injectable so it is unit-testable without the real environment.
 */
export function resolveStorageRoot(rawOverride: string | undefined, homeDirectory: string): string {
  const trimmed = rawOverride?.trim() ?? ''
  if (trimmed.length === 0) {
    return join(homeDirectory, '.tapebox')
  }

  let value = expandEnvReferences(trimmed).trim()

  // An override that is set but expands to nothing — an unset `$VAR`/`%VAR%`,
  // say — is a misconfiguration. Rejecting it is the "reported startup error,
  // not a silent fallback" the convention requires, and it avoids silently
  // collapsing the root onto the bare home directory.
  if (value.length === 0) {
    throw new Error(
      `TAPEBOX_DATA_DIR is set to "${rawOverride}" but expands to an empty path ` +
        `(an unset $VAR/%VAR%?). Set it to a usable directory, or unset it to use ~/.tapebox.`,
    )
  }

  // Expand a leading `~` / `~/` (and `~\` on Windows) to the home directory.
  if (value === '~') {
    value = homeDirectory
  } else if (value.startsWith('~/') || value.startsWith('~\\')) {
    value = join(homeDirectory, value.slice(2))
  }

  // A still-relative override is resolved against HOME, not the working
  // directory, so launch context can never move the storage root. resolve()
  // always returns an absolute path, so no further absolute-ness guard is needed.
  return isAbsolute(value) ? resolve(value) : resolve(homeDirectory, value)
}

// The storage root is resolved lazily on first access — not frozen at import —
// so resolution happens at a defined startup point with the environment fully
// known, and an unusable TAPEBOX_DATA_DIR surfaces as a reported startup error when
// ensureDirs() first reads `paths.*`, never as an import-time crash with no UI.
// Every consumer reads `paths.*` inside a function, so the first access is the
// startup ensureDirs() call.
let cachedRoot: string | null = null
function storageRoot(): string {
  if (cachedRoot === null) {
    cachedRoot = resolveStorageRoot(process.env.TAPEBOX_DATA_DIR, homedir())
  }
  return cachedRoot
}

export const paths = {
  get root()          { return storageRoot() },
  get bin()           { return join(storageRoot(), 'bin') },
  get library()       { return join(storageRoot(), 'library') },
  get logs()          { return join(storageRoot(), 'logs') },
  get temp()          { return join(storageRoot(), 'temp') },
  get config()        { return join(storageRoot(), 'config.json') },
  get catalog()       { return join(storageRoot(), 'catalog.json') },
  get layout()        { return join(storageRoot(), 'layout.json') },
  // Re-derivable managed-dependency facts (latest versions and last-check time),
  // kept apart from config.json so a settings reset never wipes them and their
  // update-check churn never rewrites the config file (persisted-store-separation).
  get dependencies()  { return join(storageRoot(), 'dependencies.json') },
  get apiKeys()       { return join(storageRoot(), 'api-keys.json') },
  // The write-through data-backup store (data-backup conventions): one add-only
  // SQLite FILE directly under the root, resolved through the same TAPEBOX_DATA_DIR-
  // aware resolver as everything else. Its `-wal`/`-shm` sidecars sit beside it.
  get backupsDb()     { return join(storageRoot(), 'backups.sqlite3') },
  // Log lines and AI calls (data-lifecycle conventions); see io/records.ts.
  get records()       { return join(storageRoot(), 'records.sqlite3') },
}

export function binaryPath(name: 'yt-dlp' | 'ffmpeg' | 'deno'): string {
  const ext = process.platform === 'win32' ? '.exe' : ''
  return join(paths.bin, `${name}${ext}`)
}

/**
 * Directories that must exist before the app reads/writes state.
 * Safe to call repeatedly (mkdir { recursive: true }) and cheap — operations
 * that depend on a particular dir should call this defensively rather than
 * trust startup, so they keep working if the user wipes ~/.tapebox between
 * startup and the operation.
 *
 * This is also the defined startup point where the storage root is first
 * resolved: `paths.*` is read here, so an unusable TAPEBOX_DATA_DIR throws from this
 * awaited call and is reported by the caller, rather than at import time.
 */
// Tightens the storage root to owner-only (0700) on POSIX, per the storage-
// path-conventions: created that way, and tightened at each launch when an
// existing root is broader, because derived data and logs must never be
// readable by accounts that cannot read their sources. Windows uses its own
// permission model and is unaffected. mkdir's own `mode` is masked by umask
// and never changes an *existing* directory's mode, so this always re-checks
// after creation rather than relying on the mkdir call alone. A failure to
// tighten is logged to the console — the records database opens later, under
// the root this call itself is establishing — and never stops the app.
async function secureRoot(rootDir: string): Promise<void> {
  if (process.platform === 'win32') return
  try {
    const info = await stat(rootDir)
    if ((info.mode & 0o077) !== 0) {
      await chmod(rootDir, 0o700)
    }
  } catch (error) {
    console.warn(`tapebox: could not tighten storage root "${rootDir}" to owner-only (0700):`, error)
  }
}

export async function ensureDirs(): Promise<void> {
  await mkdir(paths.root, { recursive: true, mode: 0o700 })
  await secureRoot(paths.root)

  const otherDirs: readonly string[] = [paths.bin, paths.library, paths.temp]
  for (const dir of otherDirs) {
    await mkdir(dir, { recursive: true })
  }
}

/**
 * Clear the staging dir once at launch, then ensure it exists. Only managed-tool
 * installs stage in temp/ (binaries/manager.ts), and this runs before any can
 * start, under the single-instance lock, so every file here was left by a
 * process that is gone. Call it ONCE from the bootstrap — never from the
 * defensive ensureDirs(), which runs mid-operation.
 *
 * Two TapeBoxes on different machines sharing one TAPEBOX_DATA_DIR are not a
 * supported setup (the catalog has no cross-host coordination either); at worst
 * the other one's install in progress fails and is tried again. A file that
 * cannot be removed is reported to the caller, never a reason to stop startup.
 */
export async function sweepAbandonedStaging(): Promise<void> {
  await mkdir(paths.temp, { recursive: true })
  const failures: unknown[] = []
  for (const name of await readdir(paths.temp)) {
    await rm(join(paths.temp, name), { recursive: true, force: true }).catch((error: unknown) => { failures.push(error) })
  }
  if (failures.length > 0) throw new AggregateError(failures, 'Some temporary staging files could not be removed.')
}
