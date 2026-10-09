import { link, open, rename, unlink, writeFile } from 'node:fs/promises'
import { dirname, extname, join } from 'node:path'
import { nanoid } from 'nanoid'
import { log } from './logger'
import { describeError } from '../../shared/error'
import { applyFileStamp, chmodWhereHeld, fileStampOf, keepOriginalMode } from './file-metadata'

/**
 * Atomically publish a file. Runs `produce(tempPath)` to write the complete,
 * ready-to-use contents into a temporary path, then fsyncs that file, renames it
 * onto `destPath`, and fsyncs the destination directory — the
 * write-temp → fsync → rename → fsync-dir discipline every managed file and
 * library replacement shares, so a power loss can never expose a half-written or
 * unflushed file at `destPath`.
 *
 * `produce` is handed an exclusively created, empty private file and must leave a finished artifact there —
 * stream into it, run a subprocess that writes it, or move a file onto it. On any
 * failure the temp is removed and the original error is rethrown unchanged; an
 * existing `destPath` is left untouched (the rename is the single atomic commit).
 * When supplied, `signal` is checked after production and again after fsync,
 * immediately before that commit.
 *
 * A file being replaced hands the temp its ordinary permission bits
 * before the rename, never its times (content-lifecycle conventions, Files). A
 * caller that decides the file's permissions itself passes `mode`, which wins.
 *
 * The temp defaults to a `<stem>-<nanoid>.tmp` sibling (see {@link defaultTempPath})
 * so the rename is always same-filesystem (atomic, never a cross-device copy), and
 * a stranded temp from a hard kill can never collide with the next attempt. Pass
 * `tempPath` when the producer constrains the name — e.g. ffmpeg picks its output
 * muxer from the extension, so its temp must still end in `.jpg`. A supplied
 * `tempPath` MUST be a sibling of `destPath` (same directory), or the rename stops
 * being atomic.
 *
 * A hard kill (SIGKILL / power loss) between produce() and rename() can strand
 * the temp; it is inert — callers key off `destPath`, never the temp.
 */
export async function writeFileAtomicVia(
  destPath: string,
  produce: (tempPath: string) => Promise<void>,
  tempPath: string = defaultTempPath(destPath),
  signal?: AbortSignal,
  mode?: number,
): Promise<void> {
  let stageCreated = false
  try {
    signal?.throwIfAborted()
    const stage = await open(tempPath, 'wx', 0o600)
    stageCreated = true
    await stage.close()
    await produce(tempPath)
    signal?.throwIfAborted()
    const keptMode = await keepOriginalMode(destPath, tempPath)
    // chmod (not the open mode) is what guarantees the exact bits regardless of
    // the process umask, on a volume that can hold them.
    if (mode !== undefined) await chmodWhereHeld(tempPath, mode)
    else if (!keptMode) await chmodWhereHeld(tempPath, 0o666 & ~process.umask())
    await fsyncFile(tempPath)
    // fsync can block long enough for a user cancellation to arrive. This is the
    // final safe boundary: the staged file is durable but has not replaced the
    // destination, so aborting here preserves the old artifact and removes stage.
    signal?.throwIfAborted()
    await rename(tempPath, destPath)
  } catch (err) {
    if (stageCreated) await removeStage(tempPath)
    throw err
  }
  // The rename is the commit; the directory sync after it cannot undo it.
  await fsyncDirBestEffort(dirname(destPath))
}

/** Codes with which a volume refuses a hard link (exFAT and FAT32 cannot hold
 * them; EXDEV is a link across volumes). */
const LINK_UNSUPPORTED = new Set(['EACCES', 'EMLINK', 'ENOSYS', 'ENOTSUP', 'EOPNOTSUPP', 'EPERM', 'EXDEV'])
const COPY_CHUNK_BYTES = 256 * 1024

function linkUnsupported(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException).code
  return code !== undefined && LINK_UNSUPPORTED.has(code)
}

/**
 * Stream `sourcePath` into a new file at `destPath`, created exclusively, so an
 * existing file there fails it with EEXIST. The new file is this copy's own, so
 * any failure or abort (checked per chunk) removes it again. This is the one
 * place a file's bytes are copied, so it is where the copy keeps the source's
 * ordinary permission bits and copy times (content-lifecycle conventions, Files).
 * Where the destination has no hard links this writes straight to the final
 * name, so power loss mid-copy can leave a truncated file there (Decisions in
 * the TapeBox plan: destinations without hard links).
 */
async function copyExclusive(sourcePath: string, destPath: string, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted()
  const source = await open(sourcePath, 'r')
  let created = false
  try {
    // Taken before reading, which can move the access time.
    const stats = await source.stat({ bigint: true })
    const destination = await open(destPath, 'wx', 0o600)
    created = true
    try {
      const buffer = Buffer.allocUnsafe(COPY_CHUNK_BYTES)
      let position = 0
      for (;;) {
        const { bytesRead } = await source.read(buffer, 0, buffer.length, position)
        if (bytesRead === 0) break
        position += bytesRead
        let written = 0
        while (written < bytesRead) {
          const result = await destination.write(buffer, written, bytesRead - written, null)
          if (result.bytesWritten === 0) throw new Error(`Could not publish ${destPath}: write made no progress`)
          written += result.bytesWritten
        }
        signal?.throwIfAborted()
      }
      // The times go last, after everything else that touches the file.
      await applyFileStamp(destination, fileStampOf(stats))
      await destination.sync()
    } finally {
      await destination.close().catch(() => {})
    }
  } catch (err) {
    if (created) await removeStage(destPath)
    throw err
  } finally {
    await source.close().catch(() => {})
  }
}

/**
 * Publish one already-complete sibling temp under `destPath` without replacing
 * anything there: a hard link fails with EEXIST when the name is taken, which is
 * the atomic no-overwrite commit. A volume without hard links gets an exclusive
 * copy instead. The temp is then removed; a stale one is inert, so its removal
 * failing does not undo the publication.
 */
export async function publishFileNoOverwrite(tempPath: string, destPath: string, syncTemp = true): Promise<void> {
  if (syncTemp) await fsyncFile(tempPath)
  try {
    await link(tempPath, destPath)
  } catch (err) {
    if (!linkUnsupported(err)) throw err
    await copyExclusive(tempPath, destPath)
  }
  await unlink(tempPath).catch(() => {})
  await fsyncDirBestEffort(dirname(destPath))
}

/** Produce and durably publish a file only if the destination is still absent at
 * the commit instant. The completed temp is removed on every failure. `mode`
 * decides its permissions; otherwise it gets the process's ordinary ones. */
export async function writeFileAtomicNoOverwriteVia(
  destPath: string,
  produce: (tempPath: string) => Promise<void>,
  mode: number = 0o666 & ~process.umask(),
): Promise<void> {
  const tempPath = defaultTempPath(destPath)
  let stageCreated = false
  try {
    const stage = await open(tempPath, 'wx', 0o600)
    stageCreated = true
    await stage.close()
    await produce(tempPath)
    await chmodWhereHeld(tempPath, mode)
    await publishFileNoOverwrite(tempPath, destPath)
  } catch (err) {
    if (stageCreated) await removeStage(tempPath)
    throw err
  }
}

/**
 * Whether `dir` can hold hard links. Probed once per operation with a tiny
 * sibling file, removed again, so a copy picks its strategy before moving any
 * bytes instead of discovering it after a full copy (exFAT and FAT32 cannot).
 */
export async function directorySupportsHardLinks(dir: string): Promise<boolean> {
  const probe = join(dir, `.tapebox-link-probe-${nanoid(10)}.tmp`)
  const linked = `${probe}.link`
  await writeFile(probe, '', { flag: 'wx', mode: 0o600 })
  try {
    await link(probe, linked)
    await unlink(linked).catch(() => {})
    return true
  } catch (err) {
    if (linkUnsupported(err)) return false
    throw err
  } finally {
    await unlink(probe).catch(() => {})
  }
}

/**
 * Copy a file to `destPath` without replacing anything already there, writing
 * each byte once. Where the destination directory has hard links, the bytes go
 * into a sibling temp that is linked onto the final name once durable, so an
 * interrupted copy never leaves a file under the final name. Without hard links
 * the bytes stream straight into an exclusive file at the final name, which a
 * failure or abort removes. `signal` is checked between chunks.
 */
export async function copyFileNoOverwrite(
  sourcePath: string,
  destPath: string,
  options: { hardLinks: boolean; signal?: AbortSignal },
): Promise<void> {
  if (!options.hardLinks) {
    await copyExclusive(sourcePath, destPath, options.signal)
    await fsyncDirBestEffort(dirname(destPath))
    return
  }
  const tempPath = defaultTempPath(destPath)
  await copyExclusive(sourcePath, tempPath, options.signal)
  try {
    options.signal?.throwIfAborted()
    await publishFileNoOverwrite(tempPath, destPath, false)
  } catch (err) {
    await removeStage(tempPath)
    throw err
  }
}

/**
 * Give `sourcePath`'s file a second name at `destPath` without replacing anything
 * there, keeping the source. On one volume that is a hard link and moves no
 * bytes; across volumes, or where links are unsupported, it is one abortable
 * copy (see {@link copyFileNoOverwrite}). The caller removes the source once its
 * own durable commit names the destination.
 */
export async function linkOrCopyNoOverwrite(
  sourcePath: string,
  destPath: string,
  signal?: AbortSignal,
): Promise<{ crossDevice: boolean }> {
  try {
    await link(sourcePath, destPath)
    await fsyncDirBestEffort(dirname(destPath))
    return { crossDevice: false }
  } catch (err) {
    if (!linkUnsupported(err)) throw err
    const crossDevice = (err as NodeJS.ErrnoException).code === 'EXDEV'
    const hardLinks = crossDevice ? await directorySupportsHardLinks(dirname(destPath)) : false
    await copyFileNoOverwrite(sourcePath, destPath, { hardLinks, signal })
    return { crossDevice }
  }
}

/** Remove files a transaction published or retired, surfacing every failure; a
 * file already gone counts as removed. Callers never turn a partial cleanup into
 * apparent success. */
export async function unlinkFiles(paths: readonly string[]): Promise<void> {
  const failures: unknown[] = []
  for (const path of paths) {
    try {
      await unlink(path)
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') failures.push(err)
    }
  }
  if (failures.length > 0) {
    throw new AggregateError(failures, 'One or more files could not be removed.')
  }
}

async function removeStage(path: string): Promise<void> {
  await unlink(path).catch((cleanupError: unknown) => {
    if ((cleanupError as NodeJS.ErrnoException).code !== 'ENOENT') log.warn('atomic stage cleanup failed', { path, error: describeError(cleanupError) })
  })
}

/**
 * `<stem>-<nanoid>.tmp` alongside destPath — stem is destPath with its final
 * extension stripped, or destPath itself when it has none (e.g. an extensionless
 * binary like `bin/ffmpeg` on POSIX). Same directory as destPath, per the
 * atomic-write-temp-files convention, so the later rename is always same-filesystem.
 */
function defaultTempPath(destPath: string): string {
  const ext = extname(destPath)
  const stem = ext ? destPath.slice(0, -ext.length) : destPath
  return `${stem}-${nanoid(10)}.tmp`
}

/**
 * fsync a file by path. Opened 'r+' (not 'r') because on Windows FlushFileBuffers
 * requires write access to the handle; the producer has already closed its own
 * writer, so fsync here flushes the inode's dirty pages to disk.
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
 * fsync a directory so the rename's new entry is itself durable. Best-effort:
 * Windows can't open a directory as a file handle and macOS treats it as a no-op,
 * so a failure there is expected and ignored — it hardens Linux and is harmless
 * elsewhere. It runs after a publication has committed, so it never throws: a
 * failed sync or close must not report a committed file as failed. A hung volume
 * is outside support.
 */
async function fsyncDirBestEffort(path: string): Promise<void> {
  const handle = await open(path, 'r').catch(() => null)
  if (!handle) return
  try {
    await handle.sync()
  } catch {
    // directory fsync unsupported on this platform
  } finally {
    await handle.close().catch(() => {})
  }
}
