import { chmod, link, lstat, open, rename, unlink, writeFile } from 'node:fs/promises'
import { dirname, extname, join } from 'node:path'
import { nanoid } from 'nanoid'
import { log } from './logger'
import { describeError } from '../../shared/error'
import { applyFileStamp, fileStampOf, keepOriginalMode, type FileStamp } from './file-metadata'

/**
 * Atomically publish a file. Runs `produce(tempPath)` to write the complete,
 * ready-to-use contents into a temporary path, then fsyncs that file, renames it
 * onto `destPath`, and fsyncs the destination directory — the
 * write-temp → fsync → rename → fsync-dir discipline that io/atomic-json.ts gets
 * from write-file-atomic, lifted out so streamed and subprocess-written files get
 * the same crash-durability: a power loss can never expose a half-written or
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
 * the temp; it is inert — callers key off `destPath`, never the temp — and the
 * later attempts use fresh sibling names and leave that stage inert.
 */
export async function writeFileAtomicVia(
  destPath: string,
  produce: (tempPath: string) => Promise<void>,
  tempPath: string = defaultTempPath(destPath),
  signal?: AbortSignal,
  mode?: number,
  beforePublish?: () => Promise<void>,
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
    // the process umask.
    if (mode !== undefined) await chmod(tempPath, mode)
    else if (!keptMode) await chmod(tempPath, 0o666 & ~process.umask())
    await fsyncFile(tempPath)
    // fsync can block long enough for a user cancellation to arrive. This is the
    // final safe boundary: the staged file is durable but has not replaced the
    // destination, so aborting here preserves the old artifact and removes stage.
    signal?.throwIfAborted()
    await beforePublish?.()
    signal?.throwIfAborted()
    await rename(tempPath, destPath)
    await fsyncDirBestEffort(dirname(destPath))
  } catch (err) {
    if (stageCreated) await unlink(tempPath).catch((cleanupError: unknown) => {
      if ((cleanupError as NodeJS.ErrnoException).code !== 'ENOENT') log.warn('atomic stage cleanup failed', { path: tempPath, error: describeError(cleanupError) })
    })
    throw err
  }
}

const LINK_UNSUPPORTED = new Set(['EACCES', 'EMLINK', 'ENOSYS', 'ENOTSUP', 'EOPNOTSUPP', 'EPERM', 'EXDEV'])
const COPY_CHUNK_BYTES = 256 * 1024

export interface ExclusivePublishSource {
  read(buffer: Buffer, offset: number, length: number, position: number): Promise<{ bytesRead: number }>
  close(): Promise<void>
  identity(): Promise<string>
  stamp(): Promise<FileStamp>
}

export interface ExclusivePublishDestination {
  write(buffer: Buffer, offset: number, length: number, position: null): Promise<{ bytesWritten: number }>
  chmod(mode: number): Promise<void>
  utimes(atime: number, mtime: number): Promise<void>
  sync(): Promise<void>
  close(): Promise<void>
  identity(): Promise<string>
}

export interface ExclusivePublishOperations {
  link(tempPath: string, destPath: string): Promise<void>
  rename(fromPath: string, toPath: string): Promise<void>
  openRead(path: string): Promise<ExclusivePublishSource>
  openExclusive(path: string): Promise<ExclusivePublishDestination>
  pathIdentity(path: string): Promise<string | null>
  unlink(path: string): Promise<void>
}

export type FileClaim = { path: string; identity: string }
type Publication = { claim: FileClaim; fallbackCode: string | null }

const realPublishOperations: ExclusivePublishOperations = {
  link,
  rename,
  openRead: async (path) => {
    const handle = await open(path, 'r')
    return {
      read: (buffer, offset, length, position) => handle.read(buffer, offset, length, position),
      close: () => handle.close(),
      identity: async () => {
        const stat = await handle.stat({ bigint: true })
        return `${stat.dev}:${stat.ino}`
      },
      stamp: async () => fileStampOf(await handle.stat({ bigint: true })),
    }
  },
  openExclusive: async (path) => {
    const handle = await open(path, 'wx')
    return {
      write: (buffer, offset, length, position) => handle.write(buffer, offset, length, position),
      chmod: (mode) => handle.chmod(mode),
      utimes: (atime, mtime) => handle.utimes(atime, mtime),
      sync: () => handle.sync(),
      close: () => handle.close(),
      identity: async () => {
        const stat = await handle.stat({ bigint: true })
        return `${stat.dev}:${stat.ino}`
      },
    }
  },
  pathIdentity: async (path) => {
    try {
      const stat = await lstat(path, { bigint: true })
      return `${stat.dev}:${stat.ino}`
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw err
    }
  },
  unlink,
}

function destinationChanged(destPath: string): NodeJS.ErrnoException {
  return Object.assign(new Error(`Destination changed during exclusive publication: ${destPath}`), {
    code: 'EEXIST',
  })
}

/** Stream `sourcePath` into an exclusive claim on `destPath`. The claim is the
 * final name, so any failure or abort (checked per chunk) removes it again. This
 * is the one place a file's bytes are copied, so it is where the copy keeps the
 * source's ordinary permission bits and copy times
 * (content-lifecycle conventions, Files). */
async function copyExclusive(
  sourcePath: string,
  destPath: string,
  operations: ExclusivePublishOperations,
  expectedSourceIdentity: string,
  signal?: AbortSignal,
): Promise<string> {
  signal?.throwIfAborted()
  const source = await operations.openRead(sourcePath)
  let destination: ExclusivePublishDestination | null = null
  let claimIdentity: string | null = null
  let committed = false
  try {
    if ((await source.identity()) !== expectedSourceIdentity) throw destinationChanged(sourcePath)
    // Taken before reading, which can move the access time.
    const stamp = await source.stamp()
    destination = await operations.openExclusive(destPath)
    const buffer = Buffer.allocUnsafe(COPY_CHUNK_BYTES)
    let readPosition = 0
    for (;;) {
      const { bytesRead } = await source.read(buffer, 0, buffer.length, readPosition)
      if (bytesRead === 0) break
      readPosition += bytesRead

      let written = 0
      while (written < bytesRead) {
        const result = await destination.write(buffer, written, bytesRead - written, null)
        if (result.bytesWritten === 0) throw new Error(`Could not publish ${destPath}: write made no progress`)
        written += result.bytesWritten
      }
      // Checked after a chunk lands, not before, so a claim given up for an abort
      // holds content: an empty file's id on FAT changes with its name, and the
      // cleanup could not tell it from a replacement.
      signal?.throwIfAborted()
    }
    // The times go last, after everything else that touches the file.
    await applyFileStamp(destination, stamp)
    await destination.sync()
    // The claim's id is read only now that its content is complete, from our own
    // handle: FAT gives a file a new id once bytes are written (storage-path
    // conventions).
    claimIdentity = await destination.identity()
    await destination.close()
    destination = null
    signal?.throwIfAborted()
    if ((await operations.pathIdentity(destPath)) !== claimIdentity) throw destinationChanged(destPath)
    committed = true
    return claimIdentity
  } catch (err) {
    let failure = err
    if (destination) {
      // Writing has stopped, so the claim's id is settled.
      if (claimIdentity === null) {
        try {
          claimIdentity = await destination.identity()
        } catch (identityError) {
          failure = new AggregateError(
            [err, identityError],
            `Exclusive publication failed and its destination claim could not be identified for cleanup: ${destPath}.`,
          )
        }
      }
      await destination.close().catch(() => {})
    }
    if (claimIdentity !== null && !committed) {
      try {
        // Never check a public pathname and then unlink it: a replacement can land
        // between those operations. Move the pathname to a private sibling first;
        // moveClaimedFile verifies the moved inode and restores a replacement.
        const removed = await unlinkClaimedFile({ path: destPath, identity: claimIdentity }, operations)
        if (!removed && (await operations.pathIdentity(destPath)) !== null) {
          failure = destinationChanged(destPath)
        }
      } catch (cleanupError) {
        failure = new AggregateError(
          [err, cleanupError],
          `Exclusive publication failed and its destination claim could not be cleaned up: ${destPath}.`,
        )
      }
    }
    throw failure
  } finally {
    await source.close().catch(() => {})
  }
}

/** Publish one already-complete sibling temp without replacing a destination.
 * Hard-linking is the atomic fast path. Filesystems without hard-link support
 * use a bounded copy into an exclusive destination claim. The fallback tracks
 * the claimed file's physical identity so cleanup never removes a concurrent
 * replacement winner and a replaced claim is never reported as success. */
async function publishFileNoOverwriteDetailed(
  tempPath: string,
  destPath: string,
  operations: ExclusivePublishOperations = realPublishOperations,
  expectedSourceIdentity?: string,
  syncSource = true,
  removeSource = true,
): Promise<Publication> {
  if (syncSource) await fsyncFile(tempPath)
  const sourceIdentity = await operations.pathIdentity(tempPath)
  if (sourceIdentity === null || (expectedSourceIdentity !== undefined && sourceIdentity !== expectedSourceIdentity)) {
    throw destinationChanged(tempPath)
  }
  let identity: string
  let fallbackCode: string | null = null
  try {
    await operations.link(tempPath, destPath)
    if ((await operations.pathIdentity(destPath)) !== sourceIdentity) throw destinationChanged(destPath)
    identity = sourceIdentity
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (!code || !LINK_UNSUPPORTED.has(code)) throw err
    fallbackCode = code
    identity = await copyExclusive(tempPath, destPath, operations, sourceIdentity)
  }
  // Destination publication is the commit point. A stale temp is inert and can
  // be cleaned later; its unlink failure must not make callers roll back or
  // report a committed output as failed.
  if (removeSource && (await operations.pathIdentity(tempPath).catch(() => null)) === sourceIdentity) {
    await operations.unlink(tempPath).catch(() => {})
  }
  await fsyncDirBestEffort(dirname(destPath))
  return { claim: { path: destPath, identity }, fallbackCode }
}

export async function publishFileNoOverwrite(
  tempPath: string,
  destPath: string,
  operations: ExclusivePublishOperations = realPublishOperations,
  expectedSourceIdentity?: string,
): Promise<FileClaim> {
  return (await publishFileNoOverwriteDetailed(tempPath, destPath, operations, expectedSourceIdentity)).claim
}

/** Produce and durably publish a file only if the destination is still absent at
 * the commit instant. The completed temp is removed on every failure. */
export async function writeFileAtomicNoOverwriteVia(
  destPath: string,
  produce: (tempPath: string) => Promise<void>,
  tempPath: string = defaultTempPath(destPath),
): Promise<FileClaim> {
  try {
    await produce(tempPath)
    return await publishFileNoOverwrite(tempPath, destPath)
  } catch (err) {
    await unlink(tempPath).catch(() => {})
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
  await writeFile(probe, '', { flag: 'wx' })
  try {
    await link(probe, linked)
    await unlink(linked).catch(() => {})
    return true
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code && LINK_UNSUPPORTED.has(code)) return false
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
 * the bytes stream straight into an exclusive claim on the final name, which a
 * failure or abort removes. `signal` is checked between chunks.
 */
export async function copyFileNoOverwrite(
  sourcePath: string,
  destPath: string,
  options: { hardLinks: boolean; signal?: AbortSignal; expectedSourceIdentity?: string },
  operations: ExclusivePublishOperations = realPublishOperations,
): Promise<FileClaim> {
  const sourceIdentity = await operations.pathIdentity(sourcePath)
  if (sourceIdentity === null) {
    throw Object.assign(new Error(`Source file is missing: ${sourcePath}`), { code: 'ENOENT' })
  }
  if (options.expectedSourceIdentity !== undefined && sourceIdentity !== options.expectedSourceIdentity) {
    throw destinationChanged(sourcePath)
  }
  if (!options.hardLinks) {
    const identity = await copyExclusive(sourcePath, destPath, operations, sourceIdentity, options.signal)
    await fsyncDirBestEffort(dirname(destPath))
    return { path: destPath, identity }
  }
  const tempPath = defaultTempPath(destPath)
  try {
    await copyExclusive(sourcePath, tempPath, operations, sourceIdentity, options.signal)
    options.signal?.throwIfAborted()
    return (await publishFileNoOverwriteDetailed(tempPath, destPath, operations, undefined, false)).claim
  } catch (err) {
    await operations.unlink(tempPath).catch(() => {})
    throw err
  }
}

/** Bind cleanup to the exact physical file this transaction created or moved. */
export async function claimFile(path: string): Promise<FileClaim> {
  const identity = await realPublishOperations.pathIdentity(path)
  if (identity === null) {
    throw Object.assign(new Error(`File disappeared before it could be claimed: ${path}`), { code: 'ENOENT' })
  }
  return { path, identity }
}

/** Move a claimed public pathname to a private sibling. When the public path was
 * replaced after the claim, preserve that replacement and put it back rather than
 * accepting it as ours. Callers use unique sibling destinations. */
export async function moveClaimedFile(
  claim: FileClaim,
  destPath: string,
  operations: ExclusivePublishOperations = realPublishOperations,
): Promise<FileClaim | null> {
  try {
    await operations.rename(claim.path, destPath)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw err
  }

  const movedIdentity = await operations.pathIdentity(destPath)
  if (movedIdentity === claim.identity) return { path: destPath, identity: movedIdentity }
  if (movedIdentity === null) return null

  try {
    await publishFileNoOverwriteDetailed(destPath, claim.path, operations, movedIdentity, false)
  } catch (restoreError) {
    throw new AggregateError(
      [destinationChanged(claim.path), restoreError],
      `A replaced file could not be restored to ${claim.path}.`,
    )
  }
  return null
}

/** Remove a transaction-owned public pathname without a check→unlink race. The
 * pathname is first moved to a private sibling, verified there, and only that
 * private claim is deleted. */
export async function unlinkClaimedFile(
  claim: FileClaim,
  operations: ExclusivePublishOperations = realPublishOperations,
): Promise<boolean> {
  const held = await moveClaimedFile(claim, defaultTempPath(claim.path), operations)
  if (!held) return false
  try {
    await operations.unlink(held.path)
  } catch (unlinkError) {
    try {
      // Put the public source name back before reporting cleanup failure. Keep the
      // private claim too: deletion already failed, and it remains a recoverable
      // path instead of making the only accessible copy disappear.
      await publishFileNoOverwriteDetailed(held.path, claim.path, operations, held.identity, false, false)
    } catch (restoreError) {
      throw new AggregateError(
        [unlinkError, restoreError],
        `Claim cleanup failed and the file could not be restored to ${claim.path}; recovery claim: ${held.path}.`,
      )
    }
    throw new AggregateError(
      [unlinkError],
      `Claim cleanup failed; the source was restored and a recovery claim remains at ${held.path}.`,
    )
  }
  return true
}

/** Remove a group of exact claims and surface every false or thrown cleanup.
 * Rollback callers must never turn a partial cleanup into apparent success. */
export async function unlinkClaimedFiles(
  claims: readonly FileClaim[],
  operations: ExclusivePublishOperations = realPublishOperations,
): Promise<void> {
  const failures: unknown[] = []
  for (const claim of claims) {
    try {
      if (!(await unlinkClaimedFile(claim, operations))) {
        failures.push(new Error(`Claim changed before cleanup and was preserved: ${claim.path}`))
      }
    } catch (err) {
      failures.push(err)
    }
  }
  if (failures.length > 0) {
    throw new AggregateError(failures, 'One or more claimed files could not be cleaned up.')
  }
}

/** Durably publish a claimed file without overwriting a late destination winner,
 * while retaining the public source claim. The caller chooses its later durable
 * authority boundary and may then remove either the exact source or destination
 * claim. This is the crash-safe primitive for multi-file/location transactions.
 * On one filesystem the publication is two hard links and moves no bytes; across
 * filesystems, or where links are unsupported, it is one abortable copy (see
 * {@link copyFileNoOverwrite}). */
export async function copyClaimedFileNoOverwrite(
  claim: FileClaim,
  destPath: string,
  operations: ExclusivePublishOperations = realPublishOperations,
  signal?: AbortSignal,
): Promise<{ claim: FileClaim; crossDevice: boolean } | null> {
  const sourceIdentity = await operations.pathIdentity(claim.path)
  if (sourceIdentity !== claim.identity) return null

  // Bind a same-filesystem source to an inert destination sibling first. This
  // preserves hard-link speed without linking a mutable public pathname directly
  // to the final name.
  const stagePath = defaultTempPath(destPath)
  let linkFailure: string | null = null
  try {
    await operations.link(claim.path, stagePath)
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (!code || !LINK_UNSUPPORTED.has(code)) throw err
    linkFailure = code
  }

  if (linkFailure === null) {
    const stageIdentity = await operations.pathIdentity(stagePath)
    if (stageIdentity !== claim.identity) {
      if (stageIdentity !== null) {
        await operations.unlink(stagePath).catch((err: NodeJS.ErrnoException) => {
          if (err.code !== 'ENOENT') throw err
        })
      }
      return null
    }
    try {
      const published = await publishFileNoOverwriteDetailed(stagePath, destPath, operations, undefined, false)
      return { claim: published.claim, crossDevice: false }
    } catch (publishError) {
      try {
        await operations.unlink(stagePath).catch((err: NodeJS.ErrnoException) => {
          if (err.code !== 'ENOENT') throw err
        })
      } catch (cleanupError) {
        throw new AggregateError(
          [publishError, cleanupError],
          `File publication failed and its source stage could not be cleaned up: ${stagePath}.`,
        )
      }
      throw publishError
    }
  }

  // No link from the source: a cross-device destination may still hold links of
  // its own, which lets the copy land in a temp before it takes the final name.
  const crossDevice = linkFailure === 'EXDEV'
  const hardLinks = crossDevice ? await directorySupportsHardLinks(dirname(destPath)) : false
  const published = await copyFileNoOverwrite(
    claim.path,
    destPath,
    { hardLinks, signal, expectedSourceIdentity: claim.identity },
    operations,
  )
  return { claim: published, crossDevice }
}

/** Relocate a claim without overwriting a late destination winner. The public
 * source remains in place throughout destination publication (including a long
 * cross-device copy). Only after the destination is durable is the exact source
 * claim removed, so a crash cannot strand the sole catalog-visible copy in a
 * private temp path. */
export async function relocateClaimedFileNoOverwrite(
  claim: FileClaim,
  destPath: string,
  operations: ExclusivePublishOperations = realPublishOperations,
  signal?: AbortSignal,
): Promise<{ claim: FileClaim; crossDevice: boolean } | null> {
  const published = await copyClaimedFileNoOverwrite(claim, destPath, operations, signal)
  if (!published) return null
  try {
    // A false result means the public source was replaced or removed after the
    // destination committed. Preserve that winner; the original bytes are already
    // durable at the destination, so the relocation itself is complete.
    await unlinkClaimedFile(claim, operations)
  } catch (cleanupError) {
    try {
      const removedDestination = await unlinkClaimedFile(published.claim, operations)
      if (!removedDestination) {
        throw new Error(`Published destination changed before rollback and was preserved: ${destPath}`)
      }
    } catch (rollbackError) {
      throw new AggregateError(
        [cleanupError, rollbackError],
        `File relocation committed but source cleanup failed, and the destination could not be rolled back: ${destPath}.`,
      )
    }
    throw cleanupError
  }

  return published
}

/** Restore an original held under a sibling name without replacing an external winner. */
export async function restoreClaimedFile(claim: FileClaim, destPath: string): Promise<FileClaim | null> {
  return (await relocateClaimedFileNoOverwrite(claim, destPath))?.claim ?? null
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
