/**
 * The startup edge for the data backup: runs one pass without blocking startup and logs the outcome. This
 * is the only place the feature logs; the pass itself ({@link runBackup}) does not. Best-effort — it never
 * blocks the window, shows an error, or crashes the app.
 *
 * Electron's main process is single-threaded, so "background" here means fire-and-forget async on the
 * event loop after the window is created: the renderer is a separate process, so this never blocks the
 * UI's paint.
 */
import { runBackup } from './backupEngine'
import { log } from '@main/io/logger'
import { describeError } from '@shared/error'
import type { BackupReport } from './backupTypes'

/** Runs one backup pass in the background and logs its outcome. Fire-and-forget; never throws. */
export function runBackupInBackground(): void {
  void runOnce()
}

async function runOnce(): Promise<void> {
  try {
    logReport(await runBackup(new Date()))
  } catch (err) {
    // The engine captures its own failures in the report; this is the final backstop so a bug here can
    // never surface to the user or take down the app.
    log.error('backup: unexpected failure', { error: describeError(err) })
  }
}

function logReport(report: BackupReport): void {
  for (const skip of report.skips) {
    log.warn('backup: skipped a file', { path: skip.path, reason: skip.reason })
  }

  if (report.indexWasReset) {
    log.warn('backup: index was unreadable and reset; this run is a full backup')
  }

  if (report.fatal !== undefined) {
    log.error('backup: run failed', { error: describeError(report.fatal) })
    return
  }

  if (report.nothingChanged) {
    log.debug('backup: nothing changed, no archive written')
    return
  }

  log.info('backup: archive written', { archive: report.archiveFileName, files: report.filesArchived })
}
