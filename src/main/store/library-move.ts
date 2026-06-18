import { copyFile, mkdir, open, rename, stat, unlink } from 'node:fs/promises'
import { join, resolve } from 'node:path'

/**
 * Move the library's flat contents from one folder to another when the user
 * changes the library folder. Path-taking and side-effect-localized (no settings,
 * no queue, no app logging) so it is unit-testable against real temp dirs, the way
 * the rest of the I/O layer is. The caller (ipc/settings) resolves the effective
 * old/new dirs and the file list, then commits the new setting only after this
 * resolves.
 *
 * A multi-file move is not atomic, and the files ARE the user's data, so the whole
 * operation is built to leave EITHER every file at the destination OR every file
 * back at the source — never a split:
 *
 *   1. Same effective dir → no-op (custom→default that resolves equal, a re-pick of
 *      the same folder, whitespace differences). Compared by resolved path.
 *   2. Create the destination dir first (recursive, idempotent).
 *   3. Collision guard, up front: if ANY entry already exists at the destination we
 *      abort before moving a single file — a relocation must never overwrite a file
 *      already in the new folder, and aborting early means nothing has moved yet.
 *   4. Per file: try rename (one inode op, instant, same-filesystem). On EXDEV
 *      (the dirs are on different volumes) fall back to copy → fsync → verify byte
 *      length → unlink the source, so the source is removed only after the copy is
 *      confirmed durable on disk.
 *   5. If any file fails, roll back every file already moved (back to the source)
 *      and rethrow. The caller keeps the OLD setting, so the catalog still points at
 *      the intact source files.
 *
 * Only the named entries are touched — files the app created and tracks (media,
 * sidecars, thumbnails). Unrelated files the user dropped in the folder are left
 * alone.
 */

export type RelocateResult =
  | { moved: false; reason: 'same-dir' }
  | { moved: true; count: number; crossDevice: boolean }

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

/**
 * fsync a file by path so a cross-device copy is durable before the source is
 * unlinked. Opened 'r+' (not 'r') because on Windows FlushFileBuffers requires
 * write access to the handle. Mirrors io/atomic-file.ts's fsyncFile.
 */
async function fsyncFile(path: string): Promise<void> {
  const handle = await open(path, 'r+')
  try {
    await handle.sync()
  } finally {
    await handle.close()
  }
}

/**
 * Move one file. Returns true if it crossed a device boundary (copy fallback),
 * false if a plain rename. Throws on any real failure, having left no partial
 * destination behind (the copy temp is the destination itself, removed on failure).
 */
async function moveOne(from: string, to: string): Promise<boolean> {
  try {
    await rename(from, to)
    return false
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EXDEV') throw err
  }

  // Cross-device: copy, fsync, verify, then unlink the source. Any failure removes
  // the partial destination and rethrows, so the source is still the only copy.
  try {
    await copyFile(from, to)
    await fsyncFile(to)
    const [srcStat, dstStat] = await Promise.all([stat(from), stat(to)])
    if (srcStat.size !== dstStat.size) {
      throw new Error(
        `Copy size mismatch for ${from} → ${to} (${srcStat.size} vs ${dstStat.size}).`,
      )
    }
  } catch (err) {
    await unlink(to).catch(() => {})
    throw err
  }
  await unlink(from)
  return true
}

/**
 * Move `entries` (basenames) from `fromDir` to `toDir`. See the module doc for the
 * full contract. `entries` should be deduplicated by the caller; duplicates would
 * make the second move fail with ENOENT (source already gone) and trigger a
 * rollback, which is safe but wasteful.
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
  // conflicting library files.
  const collisions: string[] = []
  for (const name of entries) {
    if (await pathExists(join(toDir, name))) collisions.push(name)
  }
  if (collisions.length > 0) {
    const shown = collisions.slice(0, 5).join(', ')
    const more = collisions.length > 5 ? `, and ${collisions.length - 5} more` : ''
    throw new Error(
      `The new library folder already contains ${collisions.length} file(s) with the same name (${shown}${more}). ` +
        `Move or remove them first — TapeBox won't overwrite existing files.`,
    )
  }

  const movedNames: string[] = []
  let crossDevice = false
  try {
    for (const name of entries) {
      const src = join(fromDir, name)
      // A file the catalog references but that isn't on disk (already deleted out of
      // band) is skipped, not failed — there's nothing to move and nothing to lose.
      if (!(await pathExists(src))) continue
      const crossed = await moveOne(src, join(toDir, name))
      crossDevice = crossDevice || crossed
      movedNames.push(name)
    }
  } catch (err) {
    // Roll back: move every already-moved file back to the source. Best-effort per
    // file (we can't do better than try), but the common case — a same-volume rename
    // failing partway — rolls back cleanly because each reverse rename is itself a
    // simple inode op. Rethrow the ORIGINAL failure so the caller reports the real
    // cause and keeps the old setting.
    for (const name of movedNames) {
      await rename(join(toDir, name), join(fromDir, name)).catch(async () => {
        // Cross-device reverse: copy back, then remove the destination copy.
        await copyFile(join(toDir, name), join(fromDir, name)).catch(() => {})
        await unlink(join(toDir, name)).catch(() => {})
      })
    }
    throw err
  }

  return { moved: true, count: movedNames.length, crossDevice }
}
