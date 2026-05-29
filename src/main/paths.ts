import { homedir } from 'node:os'
import { join } from 'node:path'

/**
 * All TapeBox app state lives under ~/.tapebox by convention — this is our own
 * data only. Electron/Chromium state (cache, cookies, GPU cache, etc.) is left
 * in the OS-default userData location and never mixed in here.
 *
 * 'work' is our own scratch space for in-progress downloads.
 */
export const tapeboxRoot = join(homedir(), '.tapebox')

export const paths = {
  root:           tapeboxRoot,
  bin:            join(tapeboxRoot, 'bin'),
  library:        join(tapeboxRoot, 'library'),
  logs:           join(tapeboxRoot, 'logs'),
  work:           join(tapeboxRoot, 'work'),
  workDownloads:  join(tapeboxRoot, 'work', 'downloads'),
  config:         join(tapeboxRoot, 'config.json'),
  session:        join(tapeboxRoot, 'session.json'),
  apiKeys:        join(tapeboxRoot, 'api-keys.json'),
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
  paths.work,
  paths.workDownloads,
]
