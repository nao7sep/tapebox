import { basename, dirname, extname, resolve } from 'node:path'
import { portableFilenameIdentity } from '@main/core/filename'

/** Return selected non-sidecars that no valid sidecar claimed as its media or
 * thumbnail. Companion matching uses a portable filename identity while retaining
 * the actual selected directory; a sidecar never claims a file from elsewhere. */
export function unsupportedSelectedPaths(
  selectedPaths: readonly string[],
  claimedCompanionPaths: readonly string[],
): string[] {
  const claimed = new Set(claimedCompanionPaths.map(selectionPathIdentity))
  return selectedPaths.filter((path) =>
    extname(path).toLowerCase() !== '.json' && !claimed.has(selectionPathIdentity(path)),
  )
}

function selectionPathIdentity(path: string): string {
  const absolute = resolve(path)
  return `${dirname(absolute)}\0${portableFilenameIdentity(basename(absolute))}`
}
