/**
 * Discovers what to back up by walking the `~/.tapebox/` home root, pruning the excluded subtrees
 * (`logs/`, `backups/`, `library/`, `bin/`, `temp/`). TapeBox is home-root-only — there are no external
 * managed roots — so this is the whole selection. Produces the stat'd candidates for {@link selectChanged}
 * and records a skip for any unreadable directory or file. All I/O here is metadata only — directory
 * walks and `stat`; file contents are read later, when a changed file is archived.
 *
 * Symlinks are never followed and never captured: the walk keys off the directory entry's own type
 * (`isDirectory()` / `isFile()`), and a symlink is neither, so it is silently ignored.
 *
 * Case-insensitive entry uniqueness: two source files whose archive paths fold to the same
 * lower-case string (possible on a case-sensitive filesystem) would collide to one zip entry, so the
 * first is kept and the second is recorded as a skip (see the storage-path conventions).
 */
import fs from 'node:fs'
import path from 'node:path'
import { paths } from '@main/paths'
import { forHomeFile, normalize } from './archivePaths'
import { isExcludedDir, isExcludedFile } from './homeRootExclusions'
import { truncateToSecondMs } from './backupTime'
import type { BackupCandidate, BackupSkip } from './backupTypes'

export interface CollectedRoots {
  candidates: BackupCandidate[]
  skips: BackupSkip[]
}

export async function collectRoots(): Promise<CollectedRoots> {
  const candidates: BackupCandidate[] = []
  const skips: BackupSkip[] = []
  const seen = new Set<string>()
  await collectHomeRoot(candidates, skips, seen)
  return { candidates, skips }
}

/** Walks `~/.tapebox/`, pruning the excluded `logs/`, `backups/`, `library/`, `bin/`, and `temp/`
 *  subtrees. */
async function collectHomeRoot(
  candidates: BackupCandidate[],
  skips: BackupSkip[],
  seen: Set<string>,
): Promise<void> {
  const root = paths.root
  await walk(
    root,
    root,
    skips,
    async (fullPath, relative) => {
      if (!isExcludedFile(relative)) {
        await addCandidate(candidates, skips, seen, fullPath, forHomeFile(relative))
      }
    },
    (relativeDir) => isExcludedDir(relativeDir),
  )
}

/**
 * Recursively yields each file under `root` (relative path forward-slash normalized), skipping any
 * subdirectory the optional `pruneDir` predicate rejects. An unreadable directory is a logged skip, not a
 * throw, so the rest of the tree is still captured.
 */
async function walk(
  root: string,
  dir: string,
  skips: BackupSkip[],
  onFile: (fullPath: string, relative: string) => Promise<void>,
  pruneDir?: (relativeDir: string) => boolean,
): Promise<void> {
  let entries: fs.Dirent[]
  try {
    entries = await fs.promises.readdir(dir, { withFileTypes: true })
  } catch (err) {
    skips.push({ path: dir, reason: `could not enumerate: ${errorMessage(err)}` })
    return
  }

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name)
    const relative = normalize(path.relative(root, fullPath))
    if (entry.isDirectory()) {
      if (!pruneDir?.(relative)) {
        await walk(root, fullPath, skips, onFile, pruneDir)
      }
    } else if (entry.isFile()) {
      await onFile(fullPath, relative)
    }
  }
}

async function addCandidate(
  candidates: BackupCandidate[],
  skips: BackupSkip[],
  seen: Set<string>,
  sourcePath: string,
  archivePath: string,
): Promise<void> {
  const folded = archivePath.toLowerCase()
  if (seen.has(folded)) {
    skips.push({ path: sourcePath, reason: `case-insensitive collision on archive path: ${archivePath}` })
    return
  }
  try {
    const stat = await fs.promises.stat(sourcePath)
    seen.add(folded)
    candidates.push({
      sourcePath,
      archivePath,
      sizeBytes: stat.size,
      mtimeMs: truncateToSecondMs(stat.mtimeMs),
    })
  } catch (err) {
    skips.push({ path: sourcePath, reason: `could not stat: ${errorMessage(err)}` })
  }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
