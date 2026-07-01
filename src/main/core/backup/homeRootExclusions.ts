/**
 * The optimistic exclude list for the `~/.tapebox/` home root: everything under the root is backed up
 * except the entries here. Pure, so the "did we pick the right files?" decision is unit-testable.
 *
 * Captured like any durable file: `config.json`, `catalog.json` (the tape-library structure), and
 * `api-keys.json` (secrets are backed up too — see the data-backup conventions; the `backups/` dir is
 * chmod 0700 so the secret is not downgraded). Excluded are:
 *   - the fleet floor: `logs/` (recreatable), `backups/` (the feature's own output — capturing it would
 *     recurse), `*.tmp` (atomic-write temporaries), and the OS folder-metadata litter a file manager
 *     drops into any directory the user opens (`.DS_Store`, `Thumbs.db`, `desktop.ini` — matched
 *     case-insensitively by base name at any depth).
 *   - app-specific: `library/` (downloaded media — large and re-downloadable via the catalog's source
 *     URLs), `bin/` (re-fetchable yt-dlp/ffmpeg/deno), `temp/` (disposable staging, cleared at startup),
 *     and `layout.json` (volatile window geometry — throwaway UI state).
 *
 * Paths are the forward-slash relative path under the root. (Symlinks are never followed: the collector's
 * walk uses the directory entry's own type, so a link is neither descended nor archived.)
 */
import { normalize } from './archivePaths'

const EXCLUDED_DIRS = ['logs', 'backups', 'library', 'bin', 'temp']

// Fixed-location throwaway files excluded by their exact relative path.
const EXCLUDED_FILES = new Set(['layout.json'])

// OS/file-manager metadata that appears under the root just from browsing it (see the data-backup
// conventions' fleet floor). Compared against the lowercased base name at any depth.
const OS_NOISE_NAMES = new Set(['.ds_store', 'thumbs.db', 'desktop.ini'])

function baseName(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1)
}

/** True when a home-root file must not be backed up. */
export function isExcludedFile(relativePath: string): boolean {
  const path = normalize(relativePath)
  if (path.toLowerCase().endsWith('.tmp')) return true
  if (OS_NOISE_NAMES.has(baseName(path).toLowerCase())) return true
  if (EXCLUDED_FILES.has(path)) return true
  return EXCLUDED_DIRS.some((dir) => path === dir || path.startsWith(`${dir}/`))
}

/** True when a home-root subdirectory should be pruned (not descended into) during the walk. */
export function isExcludedDir(relativeDirPath: string): boolean {
  const path = normalize(relativeDirPath)
  return EXCLUDED_DIRS.includes(path)
}
