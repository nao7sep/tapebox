import { homedir } from 'node:os'
import { join } from 'node:path'

/**
 * All TapeBox state lives under ~/.tapebox by convention.
 * Electron's userData is also redirected here (see main/index.ts).
 */
export const tapeboxRoot = join(homedir(), '.tapebox')

export const paths = {
  root:           tapeboxRoot,
  bin:            join(tapeboxRoot, 'bin'),
  library:        join(tapeboxRoot, 'library'),
  logs:           join(tapeboxRoot, 'logs'),
  cache:          join(tapeboxRoot, 'cache'),
  cacheDownloads: join(tapeboxRoot, 'cache', 'downloads'),
  cacheThumbs:    join(tapeboxRoot, 'cache', 'thumbnails'),
  config:         join(tapeboxRoot, 'config.json'),
  session:        join(tapeboxRoot, 'session.json'),
  apiKeys:        join(tapeboxRoot, 'api-keys.json'),
  binVersions:    join(tapeboxRoot, 'bin', '.versions.json'),
} as const

export function binaryPath(name: 'yt-dlp' | 'ffmpeg' | 'deno'): string {
  const ext = process.platform === 'win32' ? '.exe' : ''
  return join(paths.bin, `${name}${ext}`)
}

/**
 * Directories that must exist before the app reads/writes state.
 * Called once at startup; safe to call repeatedly (mkdir { recursive: true }).
 */
export const requiredDirs: readonly string[] = [
  paths.root,
  paths.bin,
  paths.library,
  paths.logs,
  paths.cache,
  paths.cacheDownloads,
  paths.cacheThumbs,
]
