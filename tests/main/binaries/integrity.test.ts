import { createHash } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import * as openpgp from 'openpgp'
import { parseSums, sha256OfFile, verifyDetachedSignature } from '@main/binaries/integrity'
import { EVERMEET_PRIMARY_FINGERPRINT, EVERMEET_PUBLIC_KEY_ARMORED } from '@main/binaries/evermeet-key'

const A = 'a'.repeat(64)
const B = 'b'.repeat(64)
const C = 'c'.repeat(64)

describe('parseSums', () => {
  const text = [
    `${A}  other-file`,
    `${B}  yt-dlp_macos`,
    '',
    `${C} *yt-dlp.exe`, // binary-mode marker
  ].join('\n')

  it('returns the hash for the named asset (lowercase)', () => {
    expect(parseSums(text, 'yt-dlp_macos')).toBe(B)
  })

  it('handles a binary-mode * filename prefix', () => {
    expect(parseSums(text, 'yt-dlp.exe')).toBe(C)
  })

  it('returns null when the asset is not listed', () => {
    expect(parseSums(text, 'not-present')).toBeNull()
  })

  it('ignores malformed lines', () => {
    expect(parseSums('garbage\nnot a sum line\n', 'yt-dlp_macos')).toBeNull()
  })
})

describe('sha256OfFile', () => {
  let dir: string
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'tapebox-integrity-'))
  })
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('matches node crypto over the same bytes', async () => {
    const path = join(dir, 'blob')
    const bytes = Buffer.from('hello tapebox\nsecond line\n')
    await writeFile(path, bytes)

    const expected = createHash('sha256').update(bytes).digest('hex')
    expect(await sha256OfFile(path)).toBe(expected)
  })
})

describe('verifyDetachedSignature', () => {
  // Generate a throwaway key, detach-sign a buffer, and round-trip it through the
  // verifier — covers the OpenPGP path used for evermeet's ffmpeg without the network
  // or the pinned key.
  async function makeKeyAndSig(data: Uint8Array) {
    const { privateKey, publicKey } = await openpgp.generateKey({
      type: 'ecc',
      curve: 'curve25519Legacy',
      userIDs: [{ name: 'Test Signer', email: 'test@example.invalid' }],
      format: 'armored',
    })
    const signingKey = await openpgp.readPrivateKey({ armoredKey: privateKey })
    const signature = await openpgp.sign({
      message: await openpgp.createMessage({ binary: data }),
      signingKeys: signingKey,
      detached: true,
      format: 'binary',
    })
    return { publicKey, signature: signature as Uint8Array }
  }

  const data = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10])

  it('accepts a valid signature from the matching key', async () => {
    const { publicKey, signature } = await makeKeyAndSig(data)
    expect(await verifyDetachedSignature(data, signature, publicKey)).toBe(true)
  })

  it('rejects tampered data', async () => {
    const { publicKey, signature } = await makeKeyAndSig(data)
    const tampered = data.slice()
    tampered[3] ^= 0xff
    expect(await verifyDetachedSignature(tampered, signature, publicKey)).toBe(false)
  })

  it('rejects a signature from a different key', async () => {
    const { signature } = await makeKeyAndSig(data)
    const { publicKey: otherKey } = await makeKeyAndSig(data)
    expect(await verifyDetachedSignature(data, signature, otherKey)).toBe(false)
  })
})

describe('pinned evermeet key', () => {
  it('parses and matches the expected fingerprint (guards an accidental key swap)', async () => {
    const key = await openpgp.readKey({ armoredKey: EVERMEET_PUBLIC_KEY_ARMORED })
    expect(key.getFingerprint().toLowerCase()).toBe(EVERMEET_PRIMARY_FINGERPRINT)
  })
})
