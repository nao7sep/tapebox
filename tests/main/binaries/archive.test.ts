import { access, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// unzipper is mocked so the tests can drive the exact entry shapes that matter —
// exact vs basename matches, an ambiguous basename, a directory entry, a missing
// entry, and an entry whose stream errors mid-read — without crafting real zip
// fixtures. extractFileFromZip only touches `directory.files` and `.stream()`, so
// a faithful stand-in for those exercises the real code; the output side is a
// real temp dir, so the streamed write to outPath genuinely runs.
const { openFile } = vi.hoisted(() => ({ openFile: vi.fn() }))
vi.mock('unzipper', () => ({ default: { Open: { file: openFile } } }))

import { extractFileFromZip } from '@main/binaries/archive'

type FakeEntry = { type: 'File' | 'Directory'; path: string; stream: () => Readable }

function file(path: string, makeStream: () => Readable): FakeEntry {
  return { type: 'File', path, stream: makeStream }
}

function dirEntry(path: string): FakeEntry {
  return { type: 'Directory', path, stream: () => Readable.from([]) }
}

/** A source that emits the given bytes in one chunk and closes cleanly. */
function bytes(...data: number[]): () => Readable {
  return () => Readable.from([Buffer.from(data)])
}

function archiveOf(...entries: FakeEntry[]): void {
  openFile.mockResolvedValue({ files: entries })
}

let dir: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'tapebox-archive-'))
  openFile.mockReset()
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

async function exists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

describe('extractFileFromZip', () => {
  it('extracts a matching entry to outPath', async () => {
    archiveOf(file('deno', bytes(1, 2, 3)))
    const out = join(dir, 'deno')

    await extractFileFromZip('archive.zip', 'deno', out)

    expect([...(await readFile(out))]).toEqual([1, 2, 3])
  })

  it('matches a nested entry by basename', async () => {
    archiveOf(file('ffmpeg-7.1/readme.txt', bytes(0)), file('ffmpeg-7.1/bin/ffmpeg', bytes(9, 9)))
    const out = join(dir, 'ffmpeg')

    await extractFileFromZip('archive.zip', 'ffmpeg', out)

    expect([...(await readFile(out))]).toEqual([9, 9])
  })

  it('prefers an exact path match over a basename match', async () => {
    archiveOf(file('nested/ffmpeg', bytes(1)), file('ffmpeg', bytes(2, 2)))
    const out = join(dir, 'ffmpeg')

    await extractFileFromZip('archive.zip', 'ffmpeg', out)

    // The top-level 'ffmpeg' (exact), not 'nested/ffmpeg' (basename).
    expect([...(await readFile(out))]).toEqual([2, 2])
  })

  it('throws on an ambiguous basename match rather than guessing', async () => {
    archiveOf(file('x/ffmpeg', bytes(1)), file('y/ffmpeg', bytes(2)))
    const out = join(dir, 'ffmpeg')

    await expect(extractFileFromZip('archive.zip', 'ffmpeg', out)).rejects.toThrow(
      'File ffmpeg matches multiple entries in archive: x/ffmpeg, y/ffmpeg',
    )
    expect(await exists(out)).toBe(false)
  })

  it('ignores a directory entry whose path matches the name', async () => {
    archiveOf(dirEntry('ffmpeg'), dirEntry('bin/ffmpeg'))
    const out = join(dir, 'ffmpeg')

    await expect(extractFileFromZip('archive.zip', 'ffmpeg', out)).rejects.toThrow('not found in archive')
    expect(await exists(out)).toBe(false)
  })

  it('throws naming the available files when the entry is missing, writing nothing', async () => {
    archiveOf(file('readme.txt', bytes(0)), file('LICENSE', bytes(0)))
    const out = join(dir, 'deno')

    await expect(extractFileFromZip('archive.zip', 'deno', out)).rejects.toThrow(
      'File deno not found in archive. Available: readme.txt, LICENSE',
    )
    expect(await exists(out)).toBe(false)
  })

  it('rejects (instead of crashing) when the entry stream errors mid-read', async () => {
    // A source that yields a chunk then errors — the shape a bare .pipe() let
    // escape as an unhandled 'error' event (process crash). pipeline must surface
    // it as a rejection. (Removing the half-written outPath is the caller's job
    // via writeFileAtomicVia; see atomic-file.test.ts.)
    archiveOf(
      file('deno', () => {
        let sent = false
        return new Readable({
          read() {
            if (!sent) {
              sent = true
              this.push(Buffer.from([7]))
            } else {
              this.destroy(new Error('corrupt entry'))
            }
          },
        })
      }),
    )
    const out = join(dir, 'deno')

    await expect(extractFileFromZip('archive.zip', 'deno', out)).rejects.toThrow('corrupt entry')
  })
})
