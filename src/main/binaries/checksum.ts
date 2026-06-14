import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { pipeline } from 'node:stream/promises'
import { fetchText } from '@main/io/fetch-json'
import type { ResolvedAsset } from './registry'

/**
 * Vendor checksum verification for downloaded binaries. These bytes are made
 * executable, so they are checked against the vendor's published SHA-256 before
 * install. The expected hash comes either directly from the resolve step (evermeet's
 * ffmpeg JSON carries one) or from a `<sha256>  <filename>` sums file fetched at
 * install time (yt-dlp's SHA2-256SUMS). A vendor that publishes neither yields null —
 * the caller installs unverified and logs that gap rather than failing.
 */

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

/** The vendor-published SHA-256 for a resolved asset, or null if none is published. */
export async function resolveExpectedSha256(asset: ResolvedAsset): Promise<string | null> {
  if (asset.sha256) return asset.sha256.toLowerCase()
  if (asset.checksums) return parseSums(await fetchText(asset.checksums.url), asset.checksums.assetName)
  return null
}
