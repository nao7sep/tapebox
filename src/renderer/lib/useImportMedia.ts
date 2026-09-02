import { ipcInvoke } from '@renderer/ipc/client'
import { useImportResultStore, type ImportAttempt } from '@renderer/store/importResult'
import { presentFailure } from './presentFailure'
import type { ImportIssue } from '@shared/ipc-contract'

/**
 * The single picker/drop admission and durable import path. Full success is quiet
 * because the new rows are visible; every committed non-success is retained in
 * the tape collection's result surface. A cancelled picker remains silent.
 */
export function useImportMedia(): (
  paths: string[],
  preliminaryIssues?: ImportIssue[],
  attempt?: ImportAttempt,
) => Promise<void> {
  const settle = useImportResultStore((s) => s.settle)
  return async (paths, preliminaryIssues = [], suppliedAttempt) => {
    if (paths.length === 0 && preliminaryIssues.length === 0) return
    const attempt = suppliedAttempt ?? {
      operationKey: importOperationKey(paths),
      entryKey: 'import',
    }
    if (paths.length === 0) {
      settle(attempt, { imported: [], issues: preliminaryIssues })
      return
    }
    try {
      const result = await ipcInvoke('library:import', { paths })
      const combined = { ...result, issues: [...result.issues, ...preliminaryIssues] }
      // A complete success is represented by its new tape rows. It does not erase
      // an unrelated earlier issue that the user has not dismissed.
      settle(attempt, combined.issues.length > 0 ? combined : null)
    } catch (err) {
      settle(attempt, {
        imported: [],
        issues: [
          { path: 'Selected files', reason: presentFailure(err, 'The selected files could not be imported. Check that they are still available and try again.', 'library import failed'), severity: 'error' },
          ...preliminaryIssues,
        ],
      })
    }
  }
}

export function importOperationKey(paths: readonly string[]): string {
  return JSON.stringify([...new Set(paths)].sort())
}
