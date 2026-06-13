import { open, rename, unlink } from 'node:fs/promises'
import { dirname } from 'node:path'

/**
 * Atomically publish a file. Runs `produce(tempPath)` to write the complete,
 * ready-to-use contents into a temporary path, then fsyncs that file, renames it
 * onto `destPath`, and fsyncs the destination directory — the
 * write-temp → fsync → rename → fsync-dir discipline that io/atomic-json.ts gets
 * from write-file-atomic, lifted out so streamed and subprocess-written files get
 * the same crash-durability: a power loss can never expose a half-written or
 * unflushed file at `destPath`.
 *
 * `produce` is handed the temp path and must leave a finished artifact there —
 * stream into it, run a subprocess that writes it, or move a file onto it. On any
 * failure the temp is removed and the original error is rethrown unchanged; an
 * existing `destPath` is left untouched (the rename is the single atomic commit).
 *
 * The temp defaults to a `${destPath}.partial` sibling so the rename is always
 * same-filesystem (atomic, never a cross-device copy). Pass `tempPath` when the
 * producer constrains the name — e.g. ffmpeg picks its output muxer from the
 * extension, so its temp must still end in `.jpg`. A supplied `tempPath` MUST be
 * a sibling of `destPath` (same directory), or the rename stops being atomic.
 *
 * A hard kill (SIGKILL / power loss) between produce() and rename() can strand
 * the temp; it is inert — callers key off `destPath`, never the temp — and the
 * next attempt overwrites it. That is the same trade-off write-file-atomic makes.
 */
export async function writeFileAtomicVia(
  destPath: string,
  produce: (tempPath: string) => Promise<void>,
  tempPath: string = `${destPath}.partial`,
): Promise<void> {
  try {
    await produce(tempPath)
    await fsyncFile(tempPath)
    await rename(tempPath, destPath)
    await fsyncDirBestEffort(dirname(destPath))
  } catch (err) {
    await unlink(tempPath).catch(() => {})
    throw err
  }
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
 * elsewhere.
 */
async function fsyncDirBestEffort(path: string): Promise<void> {
  const handle = await open(path, 'r').catch(() => null)
  if (!handle) return
  try {
    await handle.sync()
  } catch {
    // directory fsync unsupported on this platform
  } finally {
    await handle.close()
  }
}
