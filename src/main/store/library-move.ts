import { mkdir, stat } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import {
  claimFile,
  copyClaimedFileNoOverwrite,
  unlinkClaimedFiles,
  type FileClaim,
} from '@main/io/atomic-file'
import { portableSiblingExists } from '@main/io/portable-directory'
import { portableFilenameIdentity } from '@shared/filename'

/**
 * Move the library's flat contents from one folder to another when the user
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
 *   3. Collision guard, up front: if ANY entry already exists at the destination we
 *      abort before moving a single file — a relocation must never overwrite a file
 *      already in the new folder, and aborting early means nothing has moved yet.
 *   4. Per file: claim its inode and publish to the destination without overwrite,
 *      retaining the exact public source. Cross-device publication uses an
 *      exclusive, durable bounded copy while the public source remains visible.
 *   5. If publication or the later config save fails, remove every exact destination
 *      claim. Only after config commits may the caller remove exact source claims;
 *      a crash at any earlier phase therefore leaves the old config fully readable.
 *
 * Only the named entries are touched — files the app created and tracks (media,
 * sidecars, thumbnails). Unrelated files the user dropped in the folder are left
 * alone.
 */

export type RelocateResult =
  | { moved: false; reason: 'same-dir' }
  | { moved: true; count: number; crossDevice: boolean; files: RelocatedFile[] }

export type RelocatedFile = { name: string; sourceClaim: FileClaim; claim: FileClaim }

/**
 * Resolve whether two library paths point at the same effective directory. The
 * caller resolves blank→default before calling, but normalizing here too makes the
 * no-op check robust to trailing slashes and `.`/`..` segments.
 */
function sameDir(a: string, b: string): boolean {
  return resolve(a) === resolve(b)
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw err
  }
}

async function rollbackPublishedFiles(files: readonly RelocatedFile[]): Promise<void> {
  await unlinkClaimedFiles([...files].reverse().map((file) => file.claim))
}

/** Roll back pre-config publication using exact destination claims. The old
 * catalog-visible source claims were never removed. */
export async function rollbackLibraryRelocation(
  files: readonly RelocatedFile[],
): Promise<void> {
  await rollbackPublishedFiles(files)
}

/** Complete a relocation only after config.json durably names the destination.
 * A changed source winner is preserved and reported as an explicit partial
 * success; the authoritative destination bundle remains complete. */
export async function completeLibraryRelocation(files: readonly RelocatedFile[]): Promise<void> {
  await unlinkClaimedFiles(files.map((file) => file.sourceClaim))
}

/**
 * Publish `entries` (basenames) from `fromDir` to `toDir`. See the module doc for
 * the full contract. `entries` should be deduplicated by the caller; portable
 * aliases are rejected by preflight before any destination publication.
 */
export async function relocateLibrary(
  fromDir: string,
  toDir: string,
  entries: readonly string[],
): Promise<RelocateResult> {
  if (sameDir(fromDir, toDir)) return { moved: false, reason: 'same-dir' }

  await mkdir(toDir, { recursive: true })

  // Collision guard up front: bail before moving anything if any destination
  // already holds a file we'd otherwise overwrite. The destination must not contain
  // conflicting portable aliases. The incoming catalog itself must also be unique
  // by the same casefold/NFC identity.
  const collisions: string[] = []
  const incoming = new Set<string>()
  for (const name of entries) {
    const identity = portableFilenameIdentity(name)
    if (incoming.has(identity) || await portableSiblingExists(join(toDir, name))) collisions.push(name)
    incoming.add(identity)
  }
  if (collisions.length > 0) {
    const shown = collisions.slice(0, 5).join(', ')
    const more = collisions.length > 5 ? `, and ${collisions.length - 5} more` : ''
    throw new Error(
      `The new library folder already contains ${collisions.length} file(s) with the same name (${shown}${more}). ` +
        `Move or remove them first — TapeBox won't overwrite existing files.`,
    )
  }

  const movedFiles: RelocatedFile[] = []
  let crossDevice = false
  try {
    for (const name of entries) {
      const src = join(fromDir, name)
      // A file the catalog references but that isn't on disk (already deleted out of
      // band) is skipped, not failed — there's nothing to move and nothing to lose.
      if (!(await pathExists(src))) continue
      let sourceClaim: FileClaim
      try {
        sourceClaim = await claimFile(src)
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') continue
        throw err
      }
      // not recorded: relocation preserves an already-accounted media bundle at
      // a new managed location; it does not author new content.
      const copied = await copyClaimedFileNoOverwrite(sourceClaim, join(toDir, name))
      if (!copied) throw new Error(`Library file changed while being copied: ${src}`)
      crossDevice = crossDevice || copied.crossDevice
      movedFiles.push({ name, sourceClaim, claim: copied.claim })
    }
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
