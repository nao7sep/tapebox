import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { pipeline } from 'node:stream/promises'
import * as openpgp from 'openpgp'
import { fetchBytes, fetchText } from '@main/io/fetch-json'
import { EVERMEET_PRIMARY_FINGERPRINT, EVERMEET_PUBLIC_KEY_ARMORED } from './evermeet-key'

/**
 * Integrity verification for downloaded binaries. These bytes are made executable,
 * so they are checked against the vendor's published integrity material before
 * install. How a given vendor publishes it differs, so each resolved asset declares
 * one of:
 *
 *   - 'sums'    : a `<sha256>  <file>` sums file to fetch and match this asset's line
 *                 (yt-dlp's SHA2-256SUMS, deno's per-asset .sha256sum).
 *   - 'openpgp' : a detached OpenPGP signature beside the archive, verified against a
 *                 pinned vendor public key (evermeet's macOS ffmpeg, which ships no hash).
 *   - 'none'    : the vendor publishes nothing parseable; install proceeds unverified
 *                 (logged by the caller), with https-only transport still enforced.
 *
 * verifyBinaryIntegrity throws on an ACTUAL failure (hash mismatch, bad/absent
 * signature) so the install aborts; it returns {verified:false} only for 'none'.
 */
export type AssetIntegrity =
  | { kind: 'sums'; url: string; assetName: string }
  | { kind: 'openpgp'; signatureUrl: string }
  | { kind: 'none' }

export type IntegrityResult =
  | { verified: true; method: 'sha256' | 'openpgp' }
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
 * Verify a detached binary OpenPGP signature over `data` using `armoredKey`. True
 * iff the signature is valid AND made by (a subkey of) that key. Key-agnostic and
 * pure so it can be tested with a generated key; the pinned vendor key is applied by
 * verifyBinaryIntegrity.
 */
export async function verifyDetachedSignature(
  data: Uint8Array,
  binarySignature: Uint8Array,
  armoredKey: string,
): Promise<boolean> {
  const key = await openpgp.readKey({ armoredKey })
  const signature = await openpgp.readSignature({ binarySignature })
  const message = await openpgp.createMessage({ binary: data })
  const result = await openpgp.verify({ message, signature, verificationKeys: key })
  try {
    // Resolves only for a good signature from a verification key; rejects otherwise.
    await result.signatures[0]?.verified
    return result.signatures.length > 0
  } catch {
    return false
  }
}

/**
 * Verify a freshly-downloaded file against its declared integrity. Throws on a real
 * failure (hash mismatch / bad or missing signature) so the caller aborts the
 * install; returns {verified:false} only when the vendor publishes nothing to check.
 */
export async function verifyBinaryIntegrity(filePath: string, integrity: AssetIntegrity): Promise<IntegrityResult> {
  if (integrity.kind === 'none') return { verified: false }

  if (integrity.kind === 'sums') {
    const expected = parseSums(await fetchText(integrity.url), integrity.assetName)
    if (!expected) throw new Error(`no checksum for ${integrity.assetName} in ${integrity.url}`)
    const actual = await sha256OfFile(filePath)
    if (actual !== expected) throw new Error(`checksum mismatch (expected ${expected}, got ${actual})`)
    return { verified: true, method: 'sha256' }
  }

  // openpgp: assert the pinned key is the identity we expect before trusting it,
  // then verify the detached signature over the downloaded bytes.
  const pinned = await openpgp.readKey({ armoredKey: EVERMEET_PUBLIC_KEY_ARMORED })
  if (pinned.getFingerprint().toLowerCase() !== EVERMEET_PRIMARY_FINGERPRINT) {
    throw new Error('pinned evermeet key fingerprint mismatch')
  }
  const data = new Uint8Array(await readFile(filePath))
  const signature = await fetchBytes(integrity.signatureUrl)
  const ok = await verifyDetachedSignature(data, signature, EVERMEET_PUBLIC_KEY_ARMORED)
  if (!ok) throw new Error('OpenPGP signature verification failed')
  return { verified: true, method: 'openpgp' }
}
