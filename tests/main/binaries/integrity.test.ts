import { createHash } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// verifyBinaryIntegrity fetches the sums file via fetchText; stub it so the test
// exercises the verify logic without the network.
const fetchText = vi.fn<(url: string) => Promise<string>>()
vi.mock('@main/io/fetch-json', () => ({ fetchText: (url: string) => fetchText(url) }))

const { parseSums, sha256OfFile, verifyBinaryIntegrity } = await import('@main/binaries/integrity')

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

describe('verifyBinaryIntegrity', () => {
  let dir: string
  let filePath: string
  let fileHash: string

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'tapebox-integrity-'))
    filePath = join(dir, 'ffmpeg.zip')
    const bytes = Buffer.from('pretend archive bytes')
    await writeFile(filePath, bytes)
    fileHash = createHash('sha256').update(bytes).digest('hex')
    fetchText.mockReset()
  })
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('verifies when the sums line matches the downloaded bytes', async () => {
    fetchText.mockResolvedValue(`${fileHash}  ffmpeg.zip\n`)
    expect(await verifyBinaryIntegrity(filePath, {
      kind: 'sums', url: 'https://example.invalid/ffmpeg.zip.sha256', assetName: 'ffmpeg.zip',
    })).toEqual({ verified: true, method: 'sha256' })
  })

  it('throws on a hash mismatch (so the install aborts)', async () => {
    fetchText.mockResolvedValue(`${A}  ffmpeg.zip\n`)
    await expect(verifyBinaryIntegrity(filePath, {
      kind: 'sums', url: 'https://example.invalid/ffmpeg.zip.sha256', assetName: 'ffmpeg.zip',
    })).rejects.toThrow(/checksum mismatch/)
  })

  it('throws when the sums file has no line for the asset', async () => {
    fetchText.mockResolvedValue(`${A}  some-other-file.zip\n`)
    await expect(verifyBinaryIntegrity(filePath, {
      kind: 'sums', url: 'https://example.invalid/checksums.sha256', assetName: 'ffmpeg.zip',
    })).rejects.toThrow(/no checksum/)
  })

  it('returns unverified for a source that publishes nothing', async () => {
    expect(await verifyBinaryIntegrity(filePath, { kind: 'none' })).toEqual({ verified: false })
    expect(fetchText).not.toHaveBeenCalled()
  })
})
