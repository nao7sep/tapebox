import { createReadStream, createWriteStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import { Readable, Transform, Writable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { createInflateRaw } from 'node:zlib'
import unzipper from 'unzipper'

function trackClose<T extends Readable | Writable>(stream: T, owned: Array<{ stream: Readable | Writable; closed: Promise<void> }>): T {
  const closed = stream.closed ? Promise.resolve() : new Promise<void>((resolve) => stream.once('close', resolve))
  owned.push({ stream, closed })
  return stream
}

async function closeOwned(owned: Array<{ stream: Readable | Writable; closed: Promise<void> }>): Promise<void> {
  for (const { stream } of owned) stream.destroy()
  await Promise.all(owned.map(({ closed }) => closed))
}

function rangeEnd(start: number, length: number, archiveSize: number): number {
  const end = start + length
  if (!Number.isSafeInteger(start) || start < 0 || !Number.isSafeInteger(length) || length <= 0 ||
      !Number.isSafeInteger(end) || end > archiveSize) {
    throw new Error('Invalid ZIP source offset or size')
  }
  return end - 1
}

/** Open.custom decodes central metadata (including ZIP64), but its internal
 * .pipe() calls do not consistently propagate source errors or close readers.
 * Own those physical streams independently of its possibly stalled parser. */
async function readDirectory(zipPath: string, archiveSize: number, signal?: AbortSignal): Promise<unzipper.CentralDirectory> {
  const owned: Array<{ stream: Readable | Writable; closed: Promise<void> }> = []
  let reading = true
  let rejectRead!: (err: unknown) => void
  const failed = new Promise<never>((_resolve, reject) => { rejectRead = reject })
  const abort = () => rejectRead(signal!.reason)
  signal?.addEventListener('abort', abort, { once: true })
  try {
    signal?.throwIfAborted()
    return await Promise.race([
      unzipper.Open.custom({
        size: async () => archiveSize,
        stream(start: number, length?: number) {
          // A cancelled parser may resume a pending continuation after its caller
          // settles. It must never open another reader after cleanup started.
          if (!reading) throw new Error('ZIP metadata read has ended')
          signal?.throwIfAborted()
          const end = rangeEnd(start, length ?? archiveSize - start, archiveSize)
          const reader = trackClose(createReadStream(zipPath, { start, end }), owned)
          reader.on('error', rejectRead)
          return reader
        },
      }),
      failed,
    ])
  } finally {
    reading = false
    signal?.removeEventListener('abort', abort)
    await closeOwned(owned)
  }
}

/**
 * Extract one exact path, or a unique nested basename, into the caller's stage.
 * Only stored/deflated, unencrypted entries are supported for managed binaries.
 *
 * Use unzipper only for central metadata. Its file.stream() hides the file reader
 * and inflater, so destroying the returned stream can leave both alive. Here the
 * complete read/inflate/limit/write pipeline is owned through physical close;
 * the caller can safely remove its stage or release its install claim on return.
 * Atomic publication and durability remain writeFileAtomicVia's responsibility.
 */
export async function extractFileFromZip(
  zipPath: string,
  innerName: string,
  outPath: string,
  maxBytes: number,
  signal?: AbortSignal,
): Promise<void> {
  signal?.throwIfAborted()
  const archiveSize = (await stat(zipPath)).size
  signal?.throwIfAborted()
  const directory = await readDirectory(zipPath, archiveSize, signal)
  signal?.throwIfAborted()
  const files = directory.files.filter((f) => f.type === 'File')
  const byBasename = files.filter((f) => f.path.endsWith('/' + innerName))
  const file =
    files.find((f) => f.path === innerName) ?? (byBasename.length === 1 ? byBasename[0] : undefined)
  if (!file) {
    if (byBasename.length > 1) {
      throw new Error(
        `File ${innerName} matches multiple entries in archive: ${byBasename.map((f) => f.path).join(', ')}`,
      )
    }
    throw new Error(`File ${innerName} not found in archive. Available: ${files.map((f) => f.path).join(', ')}`)
  }

  if (directory.diskNumber !== 0 || directory.diskStart !== 0 || file.diskNumber !== 0) {
    throw new Error('Multi-disk ZIP archives are unsupported')
  }
  if (file.flags & 0x41) throw new Error(`Cannot extract encrypted ZIP entry ${innerName}`)
  if (file.compressionMethod !== 0 && file.compressionMethod !== 8) {
    throw new Error(`Unsupported ZIP compression method ${file.compressionMethod}`)
  }
  if (!Number.isSafeInteger(file.uncompressedSize) || file.uncompressedSize < 0 ||
      !Number.isSafeInteger(file.compressedSize) || file.compressedSize < 0) {
    throw new Error(`Invalid ZIP entry size for ${innerName}`)
  }
  if (file.uncompressedSize > maxBytes) {
    throw new Error(`Extracted ${innerName} is too large (${file.uncompressedSize} bytes; limit ${maxBytes})`)
  }
  const headerEnd = rangeEnd(file.offsetToLocalFileHeader, 30, archiveSize)
  if (!Number.isSafeInteger(directory.offsetToStartOfCentralDirectory) ||
      headerEnd >= directory.offsetToStartOfCentralDirectory) {
    throw new Error(`Invalid ZIP local header offset for ${innerName}`)
  }

  const owned: Array<{ stream: Readable | Writable; closed: Promise<void> }> = []
  try {
    const headerChunks: Buffer[] = []
    const headerReader = trackClose(createReadStream(zipPath, { start: file.offsetToLocalFileHeader, end: headerEnd }), owned)
    const headerWriter = trackClose(new Writable({
      write(chunk: Buffer, _encoding, callback) { headerChunks.push(chunk); callback() },
    }), owned)
    await pipeline(headerReader, headerWriter, { signal })
    const header = Buffer.concat(headerChunks)
    if (header.length !== 30 || header.readUInt32LE(0) !== 0x04034b50) {
      throw new Error(`Invalid ZIP local header for ${innerName}`)
    }
    if (header.readUInt16LE(6) & 0x41) throw new Error(`Cannot extract encrypted ZIP entry ${innerName}`)
    if (header.readUInt16LE(8) !== file.compressionMethod) {
      throw new Error(`ZIP compression method differs between headers for ${innerName}`)
    }
    const dataStart = file.offsetToLocalFileHeader + 30 + header.readUInt16LE(26) + header.readUInt16LE(28)
    const dataEnd = dataStart + file.compressedSize
    if (!Number.isSafeInteger(dataEnd) || dataEnd > directory.offsetToStartOfCentralDirectory || dataStart > dataEnd) {
      throw new Error(`Invalid ZIP payload offset or size for ${innerName}`)
    }
    signal?.throwIfAborted()
    const reader = trackClose(file.compressedSize === 0
      ? Readable.from([])
      : createReadStream(zipPath, { start: dataStart, end: rangeEnd(dataStart, file.compressedSize, archiveSize) }), owned)
    const inflater = file.compressionMethod === 8 ? trackClose(createInflateRaw(), owned) : undefined
    let extracted = 0
    const limiter = trackClose(new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        if (extracted + chunk.byteLength > maxBytes) {
          callback(new Error(`Extracted ${innerName} exceeded ${maxBytes} bytes`))
          return
        }
        extracted += chunk.byteLength
        callback(null, chunk)
      },
    }), owned)
    const writer = trackClose(createWriteStream(outPath, { mode: 0o600 }), owned)
    await pipeline(inflater ? [reader, inflater, limiter, writer] : [reader, limiter, writer], { signal })
    // The central sizes remain authoritative when local headers use a data
    // descriptor or ZIP64 placeholders; truncated/false lengths never succeed.
    if (extracted !== file.uncompressedSize || ('bytesRead' in reader && reader.bytesRead !== file.compressedSize)) {
      throw new Error(`Extracted ${innerName} size does not match ZIP metadata`)
    }
  } finally {
    await closeOwned(owned)
  }
}
