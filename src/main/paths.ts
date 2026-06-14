import { homedir } from 'node:os'
import { join } from 'node:path'
import { mkdir } from 'node:fs/promises'

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
  layout:         join(tapeboxRoot, 'layout.json'),
  apiKeys:        join(tapeboxRoot, 'api-keys.json'),
} as const

export function binaryPath(name: 'yt-dlp' | 'ffmpeg'): string {
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
