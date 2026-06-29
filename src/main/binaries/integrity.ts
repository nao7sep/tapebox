import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { pipeline } from 'node:stream/promises'
import { fetchText } from '@main/io/fetch-json'

/**
 * Integrity verification for downloaded binaries. These bytes are made executable,
 * so they are checked against the source's published SHA-256 before install. How a
 * source publishes it differs, so each resolved asset declares one of:
 *
 *   - 'sums' : a `<sha256>  <file>` sums file to fetch and match this asset's line
 *              (yt-dlp's SHA2-256SUMS, deno's per-asset .sha256sum, martin-riedl's
 *              `ffmpeg.zip.sha256`, BtbN's combined `checksums.sha256`).
 *   - 'none' : the source publishes nothing parseable; install proceeds unverified
 *              (logged by the caller), with https-only transport still enforced.
 *
 * verifyBinaryIntegrity throws on an ACTUAL failure (hash mismatch, or no line for
 * the asset) so the install aborts; it returns {verified:false} only for 'none'.
 */
export type AssetIntegrity =
  | { kind: 'sums'; url: string; assetName: string }
  | { kind: 'none' }

export type IntegrityResult =
  | { verified: true; method: 'sha256' }
  | { verified: false }

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
export async function sha256OfFile(path: string): Promise<string> {
  const hash = createHash('sha256')
  await pipeline(createReadStream(path), hash)
  return hash.digest('hex')
}

/**
 * Verify a freshly-downloaded file against its declared integrity. Throws on a real
 * failure (hash mismatch / no checksum line for the asset) so the caller aborts the
 * install; returns {verified:false} only when the source publishes nothing to check.
 */
export async function verifyBinaryIntegrity(filePath: string, integrity: AssetIntegrity): Promise<IntegrityResult> {
  if (integrity.kind === 'none') return { verified: false }

  const expected = parseSums(await fetchText(integrity.url), integrity.assetName)
  if (!expected) throw new Error(`no checksum for ${integrity.assetName} in ${integrity.url}`)
  const actual = await sha256OfFile(filePath)
  if (actual !== expected) throw new Error(`checksum mismatch (expected ${expected}, got ${actual})`)
  return { verified: true, method: 'sha256' }
}
