import { createWriteStream } from 'node:fs'
import { Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import unzipper from 'unzipper'

/**
 * Extract a single named file from a zip to outPath.
 *
 * Resolves the entry by exact path first, then by basename suffix (so a binary
 * nested as 'ffmpeg-master/bin/ffmpeg.exe' is found by 'ffmpeg.exe'). A basename
 * that matches more than one entry — with no exact match to disambiguate — throws
 * rather than silently extracting whichever the archive happened to list first.
 *
 * Streams the entry through stream.pipeline, which propagates an error from
 * either end — a corrupt/truncated entry or a failed write — as a rejection and
 * destroys both streams. A bare `.pipe()` would instead let a source-side error
 * escape as an unhandled 'error' event and crash the process. Atomicity and
 * crash-durability are the caller's concern (see writeFileAtomicVia); this only
 * lands the decompressed bytes at outPath.
 */
export async function extractFileFromZip(
  zipPath: string,
  innerName: string,
  outPath: string,
  maxBytes: number,
  signal?: AbortSignal,
): Promise<void> {
  signal?.throwIfAborted()
  const directory = await unzipper.Open.file(zipPath)
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

  const advertisedSize = (file as typeof file & {
    vars?: { uncompressedSize?: number }
  }).vars?.uncompressedSize
  if (advertisedSize !== undefined && advertisedSize > maxBytes) {
    throw new Error(`Extracted ${innerName} is too large (${advertisedSize} bytes; limit ${maxBytes})`)
  }

  let extracted = 0
  const limiter = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      if (extracted + chunk.byteLength > maxBytes) {
        callback(new Error(`Extracted ${innerName} exceeded ${maxBytes} bytes`))
        return
      }
      extracted += chunk.byteLength
      callback(null, chunk)
    },
  })
  await pipeline(file.stream(), limiter, createWriteStream(outPath), { signal })
}
