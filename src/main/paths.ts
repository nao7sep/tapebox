import { homedir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'
import { mkdir } from 'node:fs/promises'

/**
 * All TapeBox app state lives under ~/.tapebox by convention — this is our own
 * data only. Electron/Chromium state (cache, cookies, GPU cache, etc.) is left
 * in the OS-default userData location and never mixed in here.
 *
 * 'work' is our own scratch space for in-progress downloads.
 *
 * The storage root is relocatable wholesale via TAPEBOX_HOME (storage-path-
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
      `TAPEBOX_HOME is set to "${rawOverride}" but expands to an empty path ` +
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
// known, and an unusable TAPEBOX_HOME surfaces as a reported startup error when
// ensureDirs() first reads `paths.*`, never as an import-time crash with no UI.
// Every consumer reads `paths.*` inside a function, so the first access is the
// startup ensureDirs() call.
let cachedRoot: string | null = null
function storageRoot(): string {
  if (cachedRoot === null) {
    cachedRoot = resolveStorageRoot(process.env.TAPEBOX_HOME, homedir())
  }
  return cachedRoot
}

export const paths = {
  get root()          { return storageRoot() },
  get bin()           { return join(storageRoot(), 'bin') },
  get library()       { return join(storageRoot(), 'library') },
  get logs()          { return join(storageRoot(), 'logs') },
  get work()          { return join(storageRoot(), 'work') },
  get workDownloads() { return join(storageRoot(), 'work', 'downloads') },
  get config()        { return join(storageRoot(), 'config.json') },
  get session()       { return join(storageRoot(), 'session.json') },
  get layout()        { return join(storageRoot(), 'layout.json') },
  get apiKeys()       { return join(storageRoot(), 'api-keys.json') },
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
 * resolved: `paths.*` is read here, so an unusable TAPEBOX_HOME throws from this
 * awaited call and is reported by the caller, rather than at import time.
 */
export async function ensureDirs(): Promise<void> {
  const requiredDirs: readonly string[] = [
    paths.root,
    paths.bin,
    paths.library,
    paths.logs,
    paths.work,
    paths.workDownloads,
  ]
  for (const dir of requiredDirs) {
    await mkdir(dir, { recursive: true })
  }
}
