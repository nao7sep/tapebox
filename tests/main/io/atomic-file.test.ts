import * as fileIo from 'node:fs/promises'
import { access, chmod, lstat, mkdtemp, readFile, readdir, rm, stat, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  copyFileNoOverwrite,
  directorySupportsHardLinks,
  linkOrCopyNoOverwrite,
  publishFileNoOverwrite,
  unlinkFiles,
  writeFileAtomicNoOverwriteVia,
  writeFileAtomicVia,
} from '@main/io/atomic-file'

vi.mock('node:fs/promises', async (importOriginal) => ({ ...await importOriginal<typeof import('node:fs/promises')>() }))

// Real filesystem (a temp dir) so the temp → fsync → rename → cleanup is actually
// exercised end to end; the producer is the seam every caller plugs into. A
// volume without hard links is imitated by making link() refuse.

let dir: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'tapebox-atomic-'))
})

afterEach(async () => {
  vi.restoreAllMocks()
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

function failure(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(code), { code })
}

/** link() refuses as an exFAT or FAT32 volume does. */
function withoutHardLinks(code = 'EPERM') {
  return vi.spyOn(fileIo, 'link').mockImplementation(async () => { throw failure(code) })
}

describe('writeFileAtomicVia', () => {
  it('publishes produced content to destPath and removes the temp', async () => {
    const dest = join(dir, 'binary')
    let seenTemp = ''

    await writeFileAtomicVia(dest, async (tmp) => {
      seenTemp = tmp
      await writeFile(tmp, 'hello')
    })

    expect(await readFile(dest, 'utf8')).toBe('hello')
    // <stem>-<nanoid>.tmp, alongside destPath (destPath has no extension here, so
    // the stem is destPath itself).
    expect(seenTemp.startsWith(`${dest}-`)).toBe(true)
    expect(seenTemp.endsWith('.tmp')).toBe(true)
    expect(await exists(seenTemp)).toBe(false)
  })

  it('hands streamed and subprocess producers an empty private stage before any bytes', async () => {
    const dest = join(dir, 'private-stage')
    await writeFileAtomicVia(dest, async (stage) => {
      const initial = await stat(stage)
      expect(initial.size).toBe(0)
      if (process.platform !== 'win32') expect(initial.mode & 0o777).toBe(0o600)
      await writeFile(stage, 'produced bytes')
    })
    if (process.platform !== 'win32') expect((await stat(dest)).mode & 0o777).toBe(0o666 & ~process.umask())
  })

  it('does not produce into or clean a colliding stage it did not create', async () => {
    const dest = join(dir, 'destination')
    const stage = join(dir, 'collision.tmp')
    await writeFile(dest, 'original')
    await writeFile(stage, 'foreign stage')
    const produce = vi.fn(async () => {})
    await expect(writeFileAtomicVia(dest, produce, stage)).rejects.toMatchObject({ code: 'EEXIST' })
    expect(produce).not.toHaveBeenCalled()
    expect(await readFile(dest, 'utf8')).toBe('original')
    expect(await readFile(stage, 'utf8')).toBe('foreign stage')
  })

  it('atomically replaces an existing destPath', async () => {
    const dest = join(dir, 'binary')
    await writeFile(dest, 'old')

    await writeFileAtomicVia(dest, async (tmp) => {
      await writeFile(tmp, 'new')
    })

    expect(await readFile(dest, 'utf8')).toBe('new')
  })

  it('leaves an existing destPath untouched and removes the temp when produce throws', async () => {
    const dest = join(dir, 'binary')
    await writeFile(dest, 'original')
    let seenTemp = ''

    await expect(
      writeFileAtomicVia(dest, async (tmp) => {
        seenTemp = tmp
        await writeFile(tmp, 'half-written')
        throw new Error('produce failed')
      }),
    ).rejects.toThrow('produce failed')

    expect(await readFile(dest, 'utf8')).toBe('original')
    expect(await exists(seenTemp)).toBe(false)
  })

  it('creates no destPath when produce throws and none existed', async () => {
    const dest = join(dir, 'binary')
    let seenTemp = ''

    await expect(
      writeFileAtomicVia(dest, async (tmp) => {
        seenTemp = tmp
        await writeFile(tmp, 'x')
        throw new Error('boom')
      }),
    ).rejects.toThrow('boom')

    expect(await exists(dest)).toBe(false)
    expect(await exists(seenTemp)).toBe(false)
  })

  it('honors a caller-supplied temp path (e.g. an extension the producer needs)', async () => {
    const dest = join(dir, 'poster.jpg')
    const customTemp = join(dir, 'poster-abc123XYZ9.jpg')
    let seenTemp = ''

    await writeFileAtomicVia(
      dest,
      async (tmp) => {
        seenTemp = tmp
        await writeFile(tmp, 'jpegbytes')
      },
      customTemp,
    )

    expect(seenTemp).toBe(customTemp)
    expect(await readFile(dest, 'utf8')).toBe('jpegbytes')
    expect(await exists(customTemp)).toBe(false)
  })

  it('removes the caller-supplied temp when produce throws', async () => {
    const dest = join(dir, 'poster.jpg')
    const customTemp = join(dir, 'poster-abc123XYZ9.jpg')

    await expect(
      writeFileAtomicVia(
        dest,
        async (tmp) => {
          await writeFile(tmp, 'x')
          throw new Error('encode failed')
        },
        customTemp,
      ),
    ).rejects.toThrow('encode failed')

    expect(await exists(customTemp)).toBe(false)
    expect(await exists(dest)).toBe(false)
  })

  it('rechecks cancellation after fsync and before replacing the destination', async () => {
    const dest = join(dir, 'binary')
    await writeFile(dest, 'original')
    let temp = ''
    let checks = 0
    // Abort precisely on the second check: the first follows produce, while the
    // second is the required post-fsync/pre-rename commit gate.
    // A real signal, since keeping the original's attributes hands it on.
    const signal = new AbortController().signal
    signal.throwIfAborted = () => {
      checks += 1
      if (checks === 2) throw new DOMException('cancel before publish', 'AbortError')
    }

    await expect(
      writeFileAtomicVia(
        dest,
        async (tmp) => {
          temp = tmp
          await writeFile(tmp, 'replacement')
        },
        undefined,
        signal,
      ),
    ).rejects.toMatchObject({ name: 'AbortError' })

    expect(checks).toBe(2)
    expect(await readFile(dest, 'utf8')).toBe('original')
    expect(await exists(temp)).toBe(false)
  })
})

describe('writeFileAtomicVia keeps what a replace keeps', () => {
  it("gives the replacement the original's ordinary permissions, never its times", async () => {
    const dest = join(dir, 'clip.json')
    await writeFile(dest, 'old')
    const modified = new Date('2020-08-09T10:11:12.000Z')
    await utimes(dest, modified, modified)
    if (process.platform !== 'win32') await chmod(dest, 0o600)

    await writeFileAtomicVia(dest, async (tmp) => {
      await writeFile(tmp, 'new')
    })

    const replaced = await stat(dest)
    expect(await readFile(dest, 'utf8')).toBe('new')
    expect(replaced.mtimeMs).not.toBe(modified.getTime())
    if (process.platform !== 'win32') expect(replaced.mode & 0o777).toBe(0o600)
  })

  it.skipIf(process.platform === 'win32')("lets a caller's own mode win over the original's", async () => {
    const dest = join(dir, 'api-keys.json')
    await writeFile(dest, 'old')
    await chmod(dest, 0o644)

    await writeFileAtomicVia(dest, async (tmp) => {
      await writeFile(tmp, 'new')
    }, undefined, undefined, 0o600)

    expect((await stat(dest)).mode & 0o777).toBe(0o600)
  })
})


describe('writeFileAtomicNoOverwriteVia', () => {
  it('reserves a private export stage, then publishes ordinary permissions', async () => {
    const dest = join(dir, 'export.json')
    await writeFileAtomicNoOverwriteVia(dest, async (stage) => {
      expect((await stat(stage)).size).toBe(0)
      if (process.platform !== 'win32') expect((await stat(stage)).mode & 0o777).toBe(0o600)
      await writeFile(stage, 'exported content')
    })
    expect(await readFile(dest, 'utf8')).toBe('exported content')
    if (process.platform !== 'win32') expect((await stat(dest)).mode & 0o777).toBe(0o666 & ~process.umask())
  })

  it('preserves a destination created after production began and removes its temp', async () => {
    const dest = join(dir, 'claimed.bin')
    let temp = ''

    await expect(
      writeFileAtomicNoOverwriteVia(dest, async (path) => {
        temp = path
        await writeFile(path, 'ours')
        // Mutation-sensitive final-edge race: a competing process wins after any
        // caller preflight but before our publication attempt.
        await writeFile(dest, 'winner')
      }),
    ).rejects.toMatchObject({ code: 'EEXIST' })

    expect(await readFile(dest, 'utf8')).toBe('winner')
    expect(await exists(temp)).toBe(false)
  })
})

describe('no-overwrite publication without hard links', () => {
  it('copies exclusively where the volume refuses hard links, and removes the temp', async () => {
    const temp = join(dir, 'stage.tmp')
    const dest = join(dir, 'published')
    await writeFile(temp, 'bytes')
    withoutHardLinks()
    await publishFileNoOverwrite(temp, dest)
    expect(await readFile(dest, 'utf8')).toBe('bytes')
    expect(await exists(temp)).toBe(false)
  })

  it('still refuses a destination that exists, keeping it and the temp\'s owner informed', async () => {
    const temp = join(dir, 'stage.tmp')
    const dest = join(dir, 'taken')
    await writeFile(temp, 'ours')
    await writeFile(dest, 'winner')
    withoutHardLinks()
    await expect(publishFileNoOverwrite(temp, dest)).rejects.toMatchObject({ code: 'EEXIST' })
    expect(await readFile(dest, 'utf8')).toBe('winner')
  })
})

describe('copyFileNoOverwrite', () => {
  it('writes straight to the final name where hard links are unavailable', async () => {
    const source = join(dir, 'source.mp4')
    const dest = join(dir, 'copy.mp4')
    await writeFile(source, 'video bytes')
    await copyFileNoOverwrite(source, dest, { hardLinks: false })
    expect(await readFile(dest, 'utf8')).toBe('video bytes')
    expect((await readdir(dir)).sort()).toEqual(['copy.mp4', 'source.mp4'])
  })

  it('stages in a sibling temp and links it into place where hard links work', async () => {
    const source = join(dir, 'source.mp4')
    const dest = join(dir, 'copy.mp4')
    await writeFile(source, 'video bytes')
    const linked = vi.spyOn(fileIo, 'link')
    await copyFileNoOverwrite(source, dest, { hardLinks: true })
    expect(String(linked.mock.calls[0]![0])).toMatch(/copy-[A-Za-z0-9_-]{10}\.tmp$/)
    expect(linked.mock.calls[0]![1]).toBe(dest)
    expect(await readFile(dest, 'utf8')).toBe('video bytes')
    expect((await readdir(dir)).sort()).toEqual(['copy.mp4', 'source.mp4'])
  })

  it.each([false, true])('leaves nothing under the final name when aborted mid-copy (hard links: %s)', async (hardLinks) => {
    const source = join(dir, 'large.bin')
    const dest = join(dir, 'copy.bin')
    await writeFile(source, Buffer.alloc(3 * 256 * 1024, 1))
    const controller = new AbortController()
    const real = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
    vi.spyOn(fileIo, 'open').mockImplementation(async (...args) => {
      const file = await real.open(...args)
      if (args[1] !== 'wx') return file
      const write = file.write.bind(file) as (...values: unknown[]) => Promise<{ bytesWritten: number }>
      Object.assign(file, { write: async (...values: unknown[]) => { const result = await write(...values); controller.abort(); return result } })
      return file
    })
    await expect(copyFileNoOverwrite(source, dest, { hardLinks, signal: controller.signal })).rejects.toThrow()
    expect(await readdir(dir)).toEqual(['large.bin'])
  })

  it('keeps the source\'s ordinary permissions and copy times', async () => {
    const source = join(dir, 'source.mp4')
    const dest = join(dir, 'copy.mp4')
    await writeFile(source, 'bytes')
    if (process.platform !== 'win32') await chmod(source, 0o640)
    const when = new Date('2026-01-02T03:04:05Z')
    await utimes(source, when, when)
    await copyFileNoOverwrite(source, dest, { hardLinks: false })
    expect((await stat(dest)).mtimeMs).toBe(when.getTime())
    if (process.platform !== 'win32') expect((await stat(dest)).mode & 0o777).toBe(0o640)
  })

  it('does not remove a colliding copy stage it never opened', async () => {
    const source = join(dir, 'source')
    const dest = join(dir, 'copied')
    await writeFile(source, 'real source')
    const real = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
    let collision: string | undefined
    const opened = vi.spyOn(fileIo, 'open').mockImplementation(async (...args) => {
      if (String(args[0]).endsWith('.tmp') && args[1] === 'wx') {
        collision = String(args[0]); await real.writeFile(collision, 'foreign content')
      }
      return real.open(...args)
    })
    try {
      await expect(copyFileNoOverwrite(source, dest, { hardLinks: true })).rejects.toMatchObject({ code: 'EEXIST' })
      expect(await readFile(collision!, 'utf8')).toBe('foreign content')
      expect(await readFile(source, 'utf8')).toBe('real source')
      expect(await exists(dest)).toBe(false)
    } finally { opened.mockRestore() }
  })

  it('opens an exclusive real copy privately before its first bytes and restores the source mode', async () => {
    const source = join(dir, 'private-copy-source')
    const dest = join(dir, 'private-copy-destination')
    await writeFile(source, 'copied content')
    const sourceMode = (await stat(source)).mode & 0o777
    const real = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
    let observed = false
    const opened = vi.spyOn(fileIo, 'open').mockImplementation(async (...args) => {
      const file = await real.open(...args)
      try {
        if (String(args[0]) === dest && args[1] === 'wx') {
          const initial = await file.stat()
          expect(initial.size).toBe(0)
          if (process.platform !== 'win32') expect(initial.mode & 0o777).toBe(0o600)
          observed = true
        }
        return file
      } catch (error) { await file.close(); throw error }
    })
    try {
      await copyFileNoOverwrite(source, dest, { hardLinks: false })
      expect(observed).toBe(true)
      expect(await readFile(dest, 'utf8')).toBe('copied content')
      if (process.platform !== 'win32') expect((await stat(dest)).mode & 0o777).toBe(sourceMode)
    } finally { opened.mockRestore() }
  })

})

describe('linkOrCopyNoOverwrite', () => {
  it('gives the file a second name on one volume, moving no bytes and keeping the source', async () => {
    const source = join(dir, 'old.mp4')
    const dest = join(dir, 'new.mp4')
    await writeFile(source, 'bytes')
    expect(await linkOrCopyNoOverwrite(source, dest)).toEqual({ crossDevice: false })
    expect((await lstat(dest)).ino).toBe((await lstat(source)).ino)
  })

  it('copies where links are refused, reporting a link across volumes', async () => {
    const source = join(dir, 'old.mp4')
    const dest = join(dir, 'new.mp4')
    await writeFile(source, 'bytes')
    withoutHardLinks('EXDEV')
    expect(await linkOrCopyNoOverwrite(source, dest)).toEqual({ crossDevice: true })
    expect(await readFile(dest, 'utf8')).toBe('bytes')
    expect(await readFile(source, 'utf8')).toBe('bytes')
  })

  it('refuses a destination that exists, leaving both files as they were', async () => {
    const source = join(dir, 'old.mp4')
    const dest = join(dir, 'new.mp4')
    await writeFile(source, 'ours')
    await writeFile(dest, 'theirs')
    await expect(linkOrCopyNoOverwrite(source, dest)).rejects.toMatchObject({ code: 'EEXIST' })
    expect(await readFile(dest, 'utf8')).toBe('theirs')
    expect(await readFile(source, 'utf8')).toBe('ours')
  })
})

describe('unlinkFiles', () => {
  it('removes every file, counts a missing one as removed, and reports what it could not remove', async () => {
    const kept = join(dir, 'kept')
    await writeFile(join(dir, 'a'), 'a')
    await writeFile(kept, 'b')
    const real = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
    vi.spyOn(fileIo, 'unlink').mockImplementation(async (path) => {
      if (String(path) === kept) throw failure('EPERM')
      return real.unlink(path)
    })
    await expect(unlinkFiles([join(dir, 'a'), join(dir, 'missing'), kept])).rejects.toBeInstanceOf(AggregateError)
    expect(await readdir(dir)).toEqual(['kept'])
  })
})

describe('directorySupportsHardLinks', () => {
  it('reports a volume that links, and one that refuses, leaving no probe behind', async () => {
    expect(await directorySupportsHardLinks(dir)).toBe(true)
    withoutHardLinks()
    expect(await directorySupportsHardLinks(dir)).toBe(false)
    expect(await readdir(dir)).toEqual([])
  })
})

describe('after the commit', () => {
  /** Opening the destination directory for its sync yields a handle whose sync
   * and close both fail, as on a volume that rejects directory handles late. */
  async function failDirectorySync(directory: string) {
    const real = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
    return vi.spyOn(fileIo, 'open').mockImplementation(async (...args) => {
      if (String(args[0]) !== directory || args[1] !== 'r') return real.open(...args)
      const failure = Object.assign(new Error('directory sync failed'), { code: 'EIO' })
      return {
        sync: async () => { throw failure },
        close: async () => { throw failure },
      } as unknown as Awaited<ReturnType<typeof real.open>>
    })
  }

  it('reports a committed replacement as written when the directory sync and its close fail', async () => {
    const dest = join(dir, 'catalog.json')
    await writeFile(dest, 'old')
    const opened = await failDirectorySync(dir)
    try {
      await writeFileAtomicVia(dest, async (tmp) => { await writeFile(tmp, 'new') })
      expect(opened).toHaveBeenCalledWith(dir, 'r')
    } finally { opened.mockRestore() }
    expect(await readFile(dest, 'utf8')).toBe('new')
    expect(await readdir(dir)).toEqual(['catalog.json'])
  })

  it('keeps a no-overwrite publication when the directory sync and its close fail', async () => {
    const stage = join(dir, 'stage.tmp')
    const dest = join(dir, 'published')
    await writeFile(stage, 'bytes')
    const opened = await failDirectorySync(dir)
    try {
      await publishFileNoOverwrite(stage, dest)
      expect(opened).toHaveBeenCalledWith(dir, 'r')
    } finally { opened.mockRestore() }
    expect(await readFile(dest, 'utf8')).toBe('bytes')
    expect(await exists(stage)).toBe(false)
  })
})

describe('volumes that cannot hold permission bits', () => {
  const refusal = () => Object.assign(new Error('operation not supported'), { code: 'ENOTSUP' })

  it('publishes with the volume\'s own mode when chmod is unsupported', async () => {
    const chmodded = vi.spyOn(fileIo, 'chmod').mockImplementation(async () => { throw refusal() })
    try {
      await writeFileAtomicVia(join(dir, 'ordinary'), async (tmp) => { await writeFile(tmp, 'ordinary') })
      await writeFileAtomicVia(join(dir, 'secret'), async (tmp) => { await writeFile(tmp, 'secret') }, undefined, undefined, 0o600)
      await writeFileAtomicNoOverwriteVia(join(dir, 'export'), async (tmp) => { await writeFile(tmp, 'export') })
      expect(chmodded).toHaveBeenCalledTimes(3)
    } finally { chmodded.mockRestore() }
    expect(await readFile(join(dir, 'ordinary'), 'utf8')).toBe('ordinary')
    expect(await readFile(join(dir, 'secret'), 'utf8')).toBe('secret')
    expect(await readFile(join(dir, 'export'), 'utf8')).toBe('export')
    expect((await readdir(dir)).sort()).toEqual(['export', 'ordinary', 'secret'])
  })

  it('still fails, and cleans its stage, on a chmod error that is not a refusal', async () => {
    const failure = Object.assign(new Error('i/o error'), { code: 'EIO' })
    const chmodded = vi.spyOn(fileIo, 'chmod').mockImplementation(async () => { throw failure })
    try {
      await expect(writeFileAtomicVia(join(dir, 'target'), async (tmp) => { await writeFile(tmp, 'x') })).rejects.toBe(failure)
    } finally { chmodded.mockRestore() }
    expect(await readdir(dir)).toEqual([])
  })
})
