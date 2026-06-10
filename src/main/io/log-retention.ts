import { readdir, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { paths } from '@main/paths'

/**
 * Log-retention policy for per-launch session logs. Filenames start with
 * yyyymmdd-hhmmss UTC, so descending lexicographic order is newest first.
 */

export function selectPrunableLogFiles(files: readonly string[], retainCount: number): string[] {
  if (retainCount < 0) return []
  return files
    .filter((file) => file.endsWith('.log'))
    .sort()
    .reverse()
    .slice(retainCount)
}

/** Keep the N most recent .log files in the logs directory; delete the rest. */
export async function pruneOldLogs(retainCount: number, logsDir = paths.logs): Promise<void> {
  if (retainCount < 0) return

  let files: string[]
  try {
    files = await readdir(logsDir)
  } catch {
    return
  }

  for (const old of selectPrunableLogFiles(files, retainCount)) {
    try {
      await unlink(join(logsDir, old))
    } catch {
      // Log cleanup is best-effort; a stale file must never block startup.
    }
  }
}
