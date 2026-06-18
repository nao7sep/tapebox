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

  let value = expandEnvReferences(trimmed)

  // Expand a leading `~` / `~/` (and `~\` on Windows) to the home directory.
  if (value === '~') {
    value = homeDirectory
  } else if (value.startsWith('~/') || value.startsWith('~\\')) {
    value = join(homeDirectory, value.slice(2))
  }

  // A still-relative override is resolved against HOME, not the working
  // directory, so launch context can never move the storage root.
  const absolute = isAbsolute(value) ? resolve(value) : resolve(homeDirectory, value)

  if (!isAbsolute(absolute)) {
    throw new Error(
      `TAPEBOX_HOME could not be resolved to a usable absolute path (from "${rawOverride}").`,
    )
  }

  return absolute
}

export const tapeboxRoot = resolveStorageRoot(process.env.TAPEBOX_HOME, homedir())

export const paths = {
  root:           tapeboxRoot,
  bin:            join(tapeboxRoot, 'bin'),
  library:        join(tapeboxRoot, 'library'),
  logs:           join(tapeboxRoot, 'logs'),
  work:           join(tapeboxRoot, 'work'),
  workDownloads:  join(tapeboxRoot, 'work', 'downloads'),
  config:         join(tapeboxRoot, 'config.json'),
  session:        join(tapeboxRoot, 'session.json'),
  layout:         join(tapeboxRoot, 'layout.json'),
  apiKeys:        join(tapeboxRoot, 'api-keys.json'),
} as const

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
 */
const REQUIRED_DIRS: readonly string[] = [
  paths.root,
  paths.bin,
  paths.library,
  paths.logs,
  paths.work,
  paths.workDownloads,
]

export async function ensureDirs(): Promise<void> {
  for (const dir of REQUIRED_DIRS) {
    await mkdir(dir, { recursive: true })
  }
}
