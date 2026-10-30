import { mkdir, readdir, rmdir, stat } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { linkOrCopyNoOverwrite, unlinkFiles } from '@main/io/atomic-file'
import { log } from '@main/io/logger'
import { portableFilenameIdentity } from '@shared/filename'
import { UserFacingError } from '@main/user-facing-error'
import { message } from '@shared/i18n/translate'
import { truncate } from '@shared/text-cleanup'

/** A file name in a notice keeps its first graphemes; a renamed tape's can run to 240 bytes. */
const NOTICE_NAME_GRAPHEMES = 48

function shortName(name: string): string {
  const cut = truncate(name, NOTICE_NAME_GRAPHEMES)
  return cut.truncated ? `${cut.text}…` : cut.text
}

/**
 * Move the library's tracked contents from one folder to another when the user
 * changes the library folder. Path-taking and side-effect-localized (no settings,
 * no queue, no app logging) so it is unit-testable against real temp dirs, the way
 * the rest of the I/O layer is. The caller (ipc/settings) resolves the effective
 * old/new dirs and the file list, then commits the new setting only after this
 * resolves.
 *
 * A multi-file move is not atomic, and the files ARE the user's data, so the whole
 * operation retains every catalog-visible source until the caller durably commits
 * the new libraryDir authority:
 *
 *   1. Same effective dir → no-op (custom→default that resolves equal, a re-pick of
 *      the same folder, whitespace differences). Compared by resolved path.
 *   2. Create the destination dir first (recursive, idempotent).
 *   3. Collision guard, up front: if the catalog or ANY tape folder already exists at
 *      the destination we abort before moving a single file — a relocation must never
 *      overwrite or merge into what is already in the new folder, and aborting early
 *      means nothing has moved yet.
 *   4. Per file: publish to the destination without overwrite, keeping the source:
 *      a hard link on one volume; across volumes a copy into a destination temp
 *      that is linked into place (or, where the destination has no hard links,
 *      into an exclusive file that any failure removes).
 *   5. If publication fails, the caller's signal aborts it (checked between files
 *      and copy chunks), or the later config save fails, remove every published
 *      destination and the tape folders it emptied. Only after config commits may
 *      the caller remove the sources, and the source tape folders left empty;
 *      a crash at any earlier phase therefore leaves the old config fully readable.
 *      A crash leaves the copies already made, so a retry reports them as
 *      collisions for the user to clear (accepted: rare).
 *
 * Only the named entries are touched — files the app created and tracks (media,
 * sidecars, thumbnails, each in its tape's folder) and the collection catalog.
 * Unrelated files the user dropped in the folder are left alone, and a tape
 * folder holding anything else stays where it is.
 */

export type RelocateResult =
  | { moved: false; reason: 'same-dir' }
  | { moved: true; count: number; crossDevice: boolean; files: RelocatedFile[] }

export type RelocatedFile = { name: string; source: string; destination: string }

export type RelocateProgress = { filesDone: number; filesTotal: number; bytesDone: number; bytesTotal: number }

export type RelocateOptions = {
  signal?: AbortSignal
  /** Called once before the first file and after each file is published. */
  onProgress?: (progress: RelocateProgress) => void
  /** Publishes one file at its destination without overwrite; the owner of a
   * file another writer may change, such as the catalog, publishes it itself. */
  publish?: (name: string, source: string, destination: string, signal?: AbortSignal) => Promise<{ crossDevice: boolean }>
}

/**
 * Resolve whether two library paths point at the same effective directory. The
 * caller resolves blank→default before calling, but normalizing here too makes the
 * no-op check robust to trailing slashes and `.`/`..` segments.
 */
function sameDir(a: string, b: string): boolean {
  return resolve(a) === resolve(b)
}

/** Size of a file, or null when it is not on disk. */
async function fileSize(path: string): Promise<number | null> {
  try {
    return (await stat(path)).size
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw err
  }
}

async function rollbackPublishedFiles(files: readonly RelocatedFile[]): Promise<void> {
  await unlinkFiles([...files].reverse().map((file) => file.destination))
  await removeEmptiedFolders(files.map((file) => file.destination))
}

/** Remove the folders `paths` sat in once they hold nothing else. */
async function removeEmptiedFolders(paths: readonly string[]): Promise<void> {
  for (const folder of new Set(paths.map((path) => dirname(path)))) {
    await rmdir(folder).catch((error: unknown) => {
      const code = (error as NodeJS.ErrnoException).code
      if (code !== 'ENOENT' && code !== 'ENOTEMPTY' && code !== 'EEXIST') throw error
    })
  }
}

/** Roll back pre-config publication. The catalog-visible sources were never
 * removed. */
export async function rollbackLibraryRelocation(
  files: readonly RelocatedFile[],
): Promise<void> {
  await rollbackPublishedFiles(files)
}

/** Complete a relocation only after config.json durably names the destination.
 * A source that cannot be removed is reported as an explicit partial success;
 * the authoritative destination bundle remains complete. */
export async function completeLibraryRelocation(files: readonly RelocatedFile[]): Promise<void> {
  const sources = files.map((file) => file.source)
  await unlinkFiles(sources)
  // The catalog sits in the library folder itself, which stays.
  await removeEmptiedFolders(files.filter((file) => dirname(file.name) !== '.').map((file) => file.source))
}

/**
 * Publish `entries` (managed relative paths: the catalog, and `<tapeId>/<name>`
 * for each tape file) from `fromDir` to `toDir`. See the module doc for the full
 * contract. `entries` are supplied internally and should be deduplicated by the
 * caller; portable aliases are rejected by preflight before any destination
 * publication.
 */
export async function relocateLibrary(
  fromDir: string,
  toDir: string,
  entries: readonly string[],
  options: RelocateOptions = {},
): Promise<RelocateResult> {
  const { signal, onProgress, publish } = options
  if (sameDir(fromDir, toDir)) return { moved: false, reason: 'same-dir' }

  await mkdir(toDir, { recursive: true })

  // Collision guard up front: bail before moving anything if the destination
  // already holds the catalog or a tape folder of the same portable name, which
  // the move would overwrite or merge into. Each tape's files share its folder,
  // so the guard compares top-level names.
  const collisions: string[] = []
  const existing = new Set((await readdir(toDir)).map(portableFilenameIdentity))
  for (const top of new Set(entries.map((name) => name.split(/[\\/]/)[0]!))) {
    if (existing.has(portableFilenameIdentity(top))) collisions.push(top)
  }
  if (collisions.length > 0) {
    // The notice names the first five, each shortened as identifying text, and
    // counts the rest; Records keeps every complete name (interface-styling-
    // conventions, Labels). The count is a plural entry.
    log.warn('library move destination already holds files', { toDir, collisions })
    const shown = collisions.slice(0, 5).map(shortName).join(', ')
    throw new UserFacingError(
      'conflict',
      collisions.length > 5
        ? message('errors.libraryMoveCollisionsMore', { count: collisions.length, names: shown, more: collisions.length - 5 })
        : message('errors.libraryMoveCollisions', { count: collisions.length, names: shown }),
    )
  }

  // A file the catalog references but that isn't on disk (already deleted out of
  // band) is skipped, not failed — there's nothing to move and nothing to lose.
  const present: { name: string; size: number }[] = []
  for (const name of entries) {
    const size = await fileSize(join(fromDir, name))
    if (size !== null) present.push({ name, size })
  }
  const progress: RelocateProgress = {
    filesDone: 0,
    filesTotal: present.length,
    bytesDone: 0,
    bytesTotal: present.reduce((sum, file) => sum + file.size, 0),
  }
  onProgress?.({ ...progress })

  const movedFiles: RelocatedFile[] = []
  let crossDevice = false
  try {
    for (const { name, size } of present) {
      signal?.throwIfAborted()
      const source = join(fromDir, name)
      const destination = join(toDir, name)
      await mkdir(dirname(destination), { recursive: true })
      // not recorded: relocation preserves an already-accounted media bundle at
      // a new managed location; it does not author new content.
      const copied = await (publish ? publish(name, source, destination, signal) : linkOrCopyNoOverwrite(source, destination, signal))
      crossDevice = crossDevice || copied.crossDevice
      movedFiles.push({ name, source, destination })
      progress.filesDone += 1
      progress.bytesDone += size
      onProgress?.({ ...progress })
    }
    signal?.throwIfAborted()
  } catch (err) {
    try {
      await rollbackPublishedFiles(movedFiles)
    } catch (rollbackError) {
      throw new AggregateError(
        [err, rollbackError],
        'Library relocation failed and could not be fully rolled back.',
      )
    }
    throw err
  }

  return { moved: true, count: movedFiles.length, crossDevice, files: movedFiles }
}
