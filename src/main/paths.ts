import { homedir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'
import { chmod, mkdir, readdir, rm, stat } from 'node:fs/promises'
import type { BinaryName } from '@shared/ipc-contract'

/**
 * Machine-local TapeBox files live under ~/.tapebox; the configurable collection
 * folder holds its media and authoritative collection metadata. Electron's own profile
 * (Chromium caches, window placement, the single-instance lock) is machine-local
 * presentation state and cache too, so it lives under the root in its own
 * `electron` folder rather than the OS-default userData location: a relocated
 * root, such as a test's or a second profile's, keeps it apart.
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
  get collection()    { return join(storageRoot(), 'collection') },
  get logs()          { return join(storageRoot(), 'logs') },
  get temp()          { return join(storageRoot(), 'temp') },
  get config()        { return join(storageRoot(), 'config.json') },
  get layout()        { return join(storageRoot(), 'layout.json') },
  // Re-derivable managed-dependency facts (latest versions and last-check time),
  // kept apart from config.json so a settings reset never wipes them and their
  // update-check churn never rewrites the config file (persisted-store-separation).
  get dependencies()  { return join(storageRoot(), 'dependencies.json') },
  // Electron's userData: Chromium's profile, Electron's window-state store and
  // the single-instance lock. Electron owns its contents.
  get electronProfile() { return join(storageRoot(), 'electron') },
  get apiKeys()       { return join(storageRoot(), 'api-keys.json') },
  // The write-through data-backup store keeps the latest snapshot per path per
  // launch, skipping a launch's first snapshot if it matches the latest kept one.
  // Its SQLite file uses the TAPEBOX_DATA_DIR-aware root; `-wal`/`-shm` sit beside it.
  get backupsDb()     { return join(storageRoot(), 'backups.sqlite3') },
  // Log lines and AI calls (data-lifecycle conventions); see io/records.ts.
  get records()       { return join(storageRoot(), 'records.sqlite3') },
}

// The collection holds an Inbox and a Shelf, each a folder of tape folders,
// and shelf.json beside them. Tape ids use nanoid's alphabet, which has no dot,
// and are ten characters long, so no tape folder can take these names.
export const INBOX_FOLDER = 'inbox'
export const SHELF_FOLDER = 'shelf'
export const SHELF_FILE = 'shelf.json'
/** The catalog of the layout before Inbox and Shelf, converted when found
 *  (store/collection-convert.ts). */
export const LEGACY_CATALOG = 'catalog.json'
/** The default collection folder's name before it became `collection/`, renamed
 *  when found (store/stored-names.ts). */
export const LEGACY_COLLECTION_FOLDER = 'library'
export function shelfFile(collectionDir: string): string {
  return join(collectionDir, SHELF_FILE)
}

/** The folder of tape folders a tape sits in. */
export function areaDir(collectionDir: string, shelved: boolean): string {
  return join(collectionDir, shelved ? SHELF_FOLDER : INBOX_FOLDER)
}

/** A tape's own folder: its tape.json, media, sidecar and poster, and the
 *  download's and poster fetch's scratch while they exist. */
export function tapeDir(collectionDir: string, tape: { id: string; shelved: boolean }): string {
  return join(areaDir(collectionDir, tape.shelved), tape.id)
}

/** One of a tape's files, by the name its tape.json gives it. */
export function tapeFile(collectionDir: string, tape: { id: string; shelved: boolean }, name: string): string {
  return join(tapeDir(collectionDir, tape), name)
}

export function binaryPath(name: BinaryName, platform: NodeJS.Platform = process.platform): string {
  const ext = platform === 'win32' ? '.exe' : ''
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
export async function secureRoot(rootDir: string, platform: NodeJS.Platform = process.platform): Promise<void> {
  if (platform === 'win32') return
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

  const otherDirs: readonly string[] = [paths.bin, paths.collection, paths.temp]
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
 * supported setup (the collection has no cross-host coordination either); at worst
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
