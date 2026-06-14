import { createHash } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { parseSums, sha256OfFile } from '@main/binaries/checksum'

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
    dir = await mkdtemp(join(tmpdir(), 'tapebox-checksum-'))
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
