import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Real filesystem (temp dirs) so the rename / copy+fsync+verify+unlink / rollback
// is exercised end to end. The cross-device branch can't be produced by two temp
// dirs on the same volume, and a mid-move failure can't be forced on a healthy FS,
// so node:fs/promises.rename is replaced with a spy that DELEGATES to the real
// rename by default; individual tests override it to throw EXDEV / a hard error.
// Every other fs call (copyFile, stat, open, unlink, mkdir) stays real.

const realFsPromises = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
const renameSpy = vi.fn(realFsPromises.rename)

vi.mock('node:fs/promises', async () => {
  const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
  return { ...actual, rename: (...args: Parameters<typeof actual.rename>) => renameSpy(...args) }
})

const { relocateLibrary } = await import('@main/store/library-move')

let root: string
let fromDir: string
let toDir: string

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

async function seed(dir: string, name: string, content: string): Promise<void> {
  await writeFile(join(dir, name), content)
}

async function names(dir: string): Promise<string[]> {
  try {
    return (await readdir(dir)).sort()
  } catch {
    return []
  }
}

function mp4s(list: string[]): string[] {
  return list.filter((n) => n.endsWith('.mp4')).sort()
}

beforeEach(async () => {
  renameSpy.mockImplementation(realFsPromises.rename)
  root = await mkdtemp(join(tmpdir(), 'tapebox-move-'))
  fromDir = join(root, 'from')
  toDir = join(root, 'to')
  await mkdir(fromDir, { recursive: true })
})

afterEach(async () => {
  vi.restoreAllMocks()
  await rm(root, { recursive: true, force: true })
})

describe('relocateLibrary', () => {
  it('is a no-op when the source and destination resolve to the same dir', async () => {
    await seed(fromDir, 'a.mp4', 'video')
    const result = await relocateLibrary(fromDir, join(fromDir, '.', ''), ['a.mp4'])
    expect(result).toEqual({ moved: false, reason: 'same-dir' })
    expect(await readFile(join(fromDir, 'a.mp4'), 'utf8')).toBe('video')
  })

  it('moves every named file via rename, creating the destination dir', async () => {
    await seed(fromDir, 'a.mp4', 'video-a')
    await seed(fromDir, 'a.json', 'sidecar-a')
    await seed(fromDir, 'a.jpg', 'thumb-a')

    const result = await relocateLibrary(fromDir, toDir, ['a.mp4', 'a.json', 'a.jpg'])

    expect(result).toEqual({ moved: true, count: 3, crossDevice: false })
    expect(await names(toDir)).toEqual(['a.jpg', 'a.json', 'a.mp4'])
    expect(await names(fromDir)).toEqual([])
    expect(await readFile(join(toDir, 'a.mp4'), 'utf8')).toBe('video-a')
  })

  it('relocates from the default folder to a custom one (default→custom)', async () => {
    // The caller resolves blank→default before calling; here fromDir stands in for
    // the resolved default library folder and toDir for a chosen custom folder.
    await seed(fromDir, 'x.webm', 'x')
    await seed(fromDir, 'x.json', 'xj')

    const result = await relocateLibrary(fromDir, toDir, ['x.webm', 'x.json'])

    expect(result.moved).toBe(true)
    expect(await names(toDir)).toEqual(['x.json', 'x.webm'])
    expect(await names(fromDir)).toEqual([])
  })

  it('relocates from a custom folder back to the default (custom→default)', async () => {
    await seed(fromDir, 'y.mkv', 'y')
    const result = await relocateLibrary(fromDir, toDir, ['y.mkv'])
    expect(result.moved).toBe(true)
    expect(await readFile(join(toDir, 'y.mkv'), 'utf8')).toBe('y')
    expect(await exists(join(fromDir, 'y.mkv'))).toBe(false)
  })

  it('leaves unrelated files in the source untouched', async () => {
    await seed(fromDir, 'a.mp4', 'video')
    await seed(fromDir, 'notes.txt', 'mine') // not a tracked library file

    await relocateLibrary(fromDir, toDir, ['a.mp4'])

    expect(await exists(join(fromDir, 'notes.txt'))).toBe(true)
    expect(await exists(join(toDir, 'notes.txt'))).toBe(false)
    expect(await exists(join(toDir, 'a.mp4'))).toBe(true)
  })

  it('skips a catalog entry whose source file is already gone', async () => {
    await seed(fromDir, 'a.mp4', 'video')
    // 'a.json' is named but missing on disk — relocation should move what exists and
    // not fail on the missing one.
    const result = await relocateLibrary(fromDir, toDir, ['a.mp4', 'a.json'])
    expect(result).toEqual({ moved: true, count: 1, crossDevice: false })
    expect(await names(toDir)).toEqual(['a.mp4'])
  })

  it('falls back to copy+verify+unlink on a cross-device rename (EXDEV)', async () => {
    await seed(fromDir, 'a.mp4', 'video-bytes')
    await seed(fromDir, 'a.json', '{"sidecar":true}')

    // Every rename looks cross-device, so each move takes the copy fallback.
    renameSpy.mockImplementation(async () => {
      const err = new Error('EXDEV: cross-device link not permitted') as NodeJS.ErrnoException
      err.code = 'EXDEV'
      throw err
    })

    const result = await relocateLibrary(fromDir, toDir, ['a.mp4', 'a.json'])

    expect(result).toEqual({ moved: true, count: 2, crossDevice: true })
    expect(await readFile(join(toDir, 'a.mp4'), 'utf8')).toBe('video-bytes')
    expect(await readFile(join(toDir, 'a.json'), 'utf8')).toBe('{"sidecar":true}')
    expect(await names(fromDir)).toEqual([])
  })

  it('aborts with no changes when a destination file with the same name exists', async () => {
    await seed(fromDir, 'a.mp4', 'video')
    await seed(fromDir, 'a.json', 'sidecar')
    await mkdir(toDir, { recursive: true })
    await seed(toDir, 'a.json', 'PRE-EXISTING') // collision

    await expect(relocateLibrary(fromDir, toDir, ['a.mp4', 'a.json'])).rejects.toThrow(/already contains/)

    // Nothing moved: both source files intact, the pre-existing destination file
    // untouched, and no stray a.mp4 copied into the destination.
    expect(await readFile(join(fromDir, 'a.mp4'), 'utf8')).toBe('video')
    expect(await readFile(join(fromDir, 'a.json'), 'utf8')).toBe('sidecar')
    expect(await readFile(join(toDir, 'a.json'), 'utf8')).toBe('PRE-EXISTING')
    expect(await exists(join(toDir, 'a.mp4'))).toBe(false)
  })

  it('rolls back to the source and rethrows when a file move fails partway', async () => {
    await seed(fromDir, 'a.mp4', 'video-a')
    await seed(fromDir, 'b.mp4', 'video-b')
    await seed(fromDir, 'c.mp4', 'video-c')

    // The first file renames fine; the SECOND forward rename throws a non-EXDEV
    // error (no copy fallback), which must roll the first one back (a reverse rename
    // that should succeed) and abort before the third. The rollback rename must NOT
    // be the one that throws, so we key off the destination being inside toDir.
    renameSpy.mockImplementation(async (src, dest) => {
      const destStr = String(dest)
      if (destStr === join(toDir, 'b.mp4')) {
        const err = new Error('EACCES: permission denied') as NodeJS.ErrnoException
        err.code = 'EACCES'
        throw err
      }
      return realFsPromises.rename(src, dest)
    })

    await expect(relocateLibrary(fromDir, toDir, ['a.mp4', 'b.mp4', 'c.mp4'])).rejects.toThrow(/EACCES/)

    // Everything is back in the source; nothing stranded in the destination.
    expect(mp4s(await names(fromDir))).toEqual(['a.mp4', 'b.mp4', 'c.mp4'])
    expect(await readFile(join(fromDir, 'a.mp4'), 'utf8')).toBe('video-a')
    expect(mp4s(await names(toDir))).toEqual([])
  })
})
