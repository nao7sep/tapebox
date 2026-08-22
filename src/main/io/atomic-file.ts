import { link, lstat, open, rename, unlink } from 'node:fs/promises'
import { dirname, extname } from 'node:path'
import { nanoid } from 'nanoid'

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
 * When supplied, `signal` is checked after production and again after fsync,
 * immediately before that commit.
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
 * next attempt overwrites it. That is the same trade-off write-file-atomic makes.
 */
export async function writeFileAtomicVia(
  destPath: string,
  produce: (tempPath: string) => Promise<void>,
  tempPath: string = defaultTempPath(destPath),
  signal?: AbortSignal,
): Promise<void> {
  try {
    await produce(tempPath)
    signal?.throwIfAborted()
    await fsyncFile(tempPath)
    // fsync can block long enough for a user cancellation to arrive. This is the
    // final safe boundary: the staged file is durable but has not replaced the
    // destination, so aborting here preserves the old artifact and removes stage.
    signal?.throwIfAborted()
    await rename(tempPath, destPath)
    await fsyncDirBestEffort(dirname(destPath))
  } catch (err) {
    await unlink(tempPath).catch(() => {})
    throw err
  }
}

const LINK_UNSUPPORTED = new Set(['EACCES', 'EMLINK', 'ENOSYS', 'ENOTSUP', 'EOPNOTSUPP', 'EPERM', 'EXDEV'])
const COPY_CHUNK_BYTES = 256 * 1024

export interface ExclusivePublishSource {
  read(buffer: Buffer, offset: number, length: number, position: number): Promise<{ bytesRead: number }>
  close(): Promise<void>
  identity(): Promise<string>
}

export interface ExclusivePublishDestination {
  write(buffer: Buffer, offset: number, length: number, position: null): Promise<{ bytesWritten: number }>
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
    }
  },
  openExclusive: async (path) => {
    const handle = await open(path, 'wx')
    return {
      write: (buffer, offset, length, position) => handle.write(buffer, offset, length, position),
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

async function copyExclusive(
  tempPath: string,
  destPath: string,
  operations: ExclusivePublishOperations,
  expectedSourceIdentity: string,
): Promise<string> {
  const source = await operations.openRead(tempPath)
  let destination: ExclusivePublishDestination | null = null
  let claimIdentity: string | null = null
  let committed = false
  try {
    if ((await source.identity()) !== expectedSourceIdentity) throw destinationChanged(tempPath)
    destination = await operations.openExclusive(destPath)
    claimIdentity = await destination.identity()
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
    }
    await destination.sync()
    await destination.close()
    destination = null
    if ((await operations.pathIdentity(destPath)) !== claimIdentity) throw destinationChanged(destPath)
    committed = true
    return claimIdentity
  } catch (err) {
    if (destination) await destination.close().catch(() => {})
    let failure = err
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

/** Relocate a claim without overwriting a late destination winner. The public
 * source remains in place throughout destination publication (including a long
 * cross-device copy). Only after the destination is durable is the exact source
 * claim removed, so a crash cannot strand the sole catalog-visible copy in a
 * private temp path. */
export async function relocateClaimedFileNoOverwrite(
  claim: FileClaim,
  destPath: string,
  operations: ExclusivePublishOperations = realPublishOperations,
): Promise<{ claim: FileClaim; crossDevice: boolean } | null> {
  const sourceIdentity = await operations.pathIdentity(claim.path)
  if (sourceIdentity !== claim.identity) return null

  // Bind a same-filesystem source to an inert destination sibling first. This
  // preserves hard-link speed without linking a mutable public pathname directly
  // to the final name. If hard links are unavailable/cross-device, the verified
  // source handle in the exclusive-copy fallback provides the same binding.
  let publicationSource = claim
  let boundStage: FileClaim | null = null
  const stagePath = defaultTempPath(destPath)
  try {
    await operations.link(claim.path, stagePath)
    const stageIdentity = await operations.pathIdentity(stagePath)
    if (stageIdentity !== claim.identity) {
      if (stageIdentity !== null) {
        await unlinkClaimedFile({ path: stagePath, identity: stageIdentity }, operations)
      }
      return null
    }
    boundStage = { path: stagePath, identity: stageIdentity }
    publicationSource = boundStage
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (!code || !LINK_UNSUPPORTED.has(code)) throw err
  }

  let published: Publication
  try {
    published = await publishFileNoOverwriteDetailed(
      publicationSource.path,
      destPath,
      operations,
      publicationSource.identity,
      false,
      boundStage !== null,
    )
  } catch (publishError) {
    if (boundStage !== null) {
      try {
        const cleaned = await unlinkClaimedFile(boundStage, operations)
        if (!cleaned && (await operations.pathIdentity(boundStage.path)) !== null) {
          throw new Error(`Bound relocation stage changed before cleanup: ${boundStage.path}`)
        }
      } catch (cleanupError) {
        throw new AggregateError(
          [publishError, cleanupError],
          `File publication failed and its bound source stage could not be cleaned up: ${boundStage.path}.`,
        )
      }
    }
    throw publishError
  }

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

  return { claim: published.claim, crossDevice: published.fallbackCode === 'EXDEV' }
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
