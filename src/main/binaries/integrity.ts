import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { pipeline } from 'node:stream/promises'
import { fetchText } from '@main/io/fetch-json'

/**
 * Integrity verification for downloaded binaries. These bytes are made executable,
 * so they are checked against the source's published SHA-256 before install. How a
 * source publishes it differs, so each resolved asset declares:
 *
 *   - 'sums' : a `<sha256>  <file>` sums file to fetch and match this asset's line
 *              (yt-dlp's SHA2-256SUMS, deno's per-asset .sha256sum, martin-riedl's
 *              `ffmpeg.zip.sha256`, BtbN's combined `checksums.sha256`).
 * Every registered source publishes a checksum. A missing checksum asset is a
 * resolution failure, never permission to install executable bytes unverified.
 * verifyBinaryIntegrity throws on any failure so the install aborts.
 */
export type AssetIntegrity = { kind: 'sums'; url: string; assetName: string }

export type IntegrityResult = { verified: true; method: 'sha256' }

/** Parse a `<sha256>  <filename>` sums file for `assetName`'s hash (lowercase hex), or null. */
export function parseSums(text: string, assetName: string): string | null {
  for (const line of text.split('\n')) {
    // 64 hex chars, whitespace, then the filename (a leading '*' marks binary mode
    // in some checksum tools). Match the asset name exactly.
    const m = line.trim().match(/^([0-9a-fA-F]{64})\s+\*?(.+)$/)
    if (m && m[2] === assetName) return m[1].toLowerCase()
  }
  return null
}

/** SHA-256 of a file as lowercase hex. */
export async function sha256OfFile(path: string, signal?: AbortSignal): Promise<string> {
  const hash = createHash('sha256')
  await pipeline(createReadStream(path), hash, { signal })
  return hash.digest('hex')
}

/**
 * Verify a freshly-downloaded file against its declared integrity. Throws on a
 * hash mismatch or a missing checksum line so the caller aborts the install.
 */
export async function verifyBinaryIntegrity(
  filePath: string,
  integrity: AssetIntegrity,
  signal?: AbortSignal,
): Promise<IntegrityResult> {
  const expected = parseSums(await fetchText(integrity.url, { signal }), integrity.assetName)
  if (!expected) throw new Error(`no checksum for ${integrity.assetName} in ${integrity.url}`)
  const actual = await sha256OfFile(filePath, signal)
  if (actual !== expected) throw new Error(`checksum mismatch (expected ${expected}, got ${actual})`)
  return { verified: true, method: 'sha256' }
}
