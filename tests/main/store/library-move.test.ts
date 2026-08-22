import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Real filesystem (temp dirs) exercises claimed source holds, exclusive final
// publication, and rollback end to end. A link spy injects cross-device fallback
// and exact-boundary destination winners while delegating every ordinary call.

const realFsPromises = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
const renameSpy = vi.fn(realFsPromises.rename)
const linkSpy = vi.fn(realFsPromises.link)

vi.mock('node:fs/promises', async () => {
  const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
  return {
    ...actual,
    rename: (...args: Parameters<typeof actual.rename>) => renameSpy(...args),
    link: (...args: Parameters<typeof actual.link>) => linkSpy(...args),
  }
})

const {
  completeLibraryRelocation,
  relocateLibrary,
  rollbackLibraryRelocation,
} = await import('@main/store/library-move')

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
  linkSpy.mockImplementation(realFsPromises.link)
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

  it('publishes every named file while retaining sources through the config commit boundary', async () => {
    await seed(fromDir, 'a.mp4', 'video-a')
    await seed(fromDir, 'a.json', 'sidecar-a')
    await seed(fromDir, 'a.jpg', 'thumb-a')

    const result = await relocateLibrary(fromDir, toDir, ['a.mp4', 'a.json', 'a.jpg'])

    expect(result).toMatchObject({ moved: true, count: 3, crossDevice: false })
    expect(await names(toDir)).toEqual(['a.jpg', 'a.json', 'a.mp4'])
    expect(await names(fromDir)).toEqual(['a.jpg', 'a.json', 'a.mp4'])
    expect(await readFile(join(toDir, 'a.mp4'), 'utf8')).toBe('video-a')
    if (!result.moved) throw new Error('fixture did not publish')
    await completeLibraryRelocation(result.files)
    expect(await names(fromDir)).toEqual([])
  })

  it('relocates from the default folder to a custom one (default→custom)', async () => {
    // The caller resolves blank→default before calling; here fromDir stands in for
    // the resolved default library folder and toDir for a chosen custom folder.
    await seed(fromDir, 'x.webm', 'x')
    await seed(fromDir, 'x.json', 'xj')

    const result = await relocateLibrary(fromDir, toDir, ['x.webm', 'x.json'])

    expect(result.moved).toBe(true)
    expect(await names(toDir)).toEqual(['x.json', 'x.webm'])
    expect(await names(fromDir)).toEqual(['x.json', 'x.webm'])
  })

  it('relocates from a custom folder back to the default (custom→default)', async () => {
    await seed(fromDir, 'y.mkv', 'y')
    const result = await relocateLibrary(fromDir, toDir, ['y.mkv'])
    expect(result.moved).toBe(true)
    expect(await readFile(join(toDir, 'y.mkv'), 'utf8')).toBe('y')
    expect(await readFile(join(fromDir, 'y.mkv'), 'utf8')).toBe('y')
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
    expect(result).toMatchObject({ moved: true, count: 1, crossDevice: false })
    expect(await names(toDir)).toEqual(['a.mp4'])
  })

  it('falls back to copy+verify+unlink on a cross-device rename (EXDEV)', async () => {
    await seed(fromDir, 'a.mp4', 'video-bytes')
    await seed(fromDir, 'a.json', '{"sidecar":true}')

    // Destination hard links look cross-device, so publication takes the bounded
    // exclusive-copy fallback while the public source remains readable.
    linkSpy.mockImplementation(async (src, dest) => {
      if (!String(dest).startsWith(`${toDir}/`)) return realFsPromises.link(src, dest)
      const err = new Error('EXDEV: cross-device link not permitted') as NodeJS.ErrnoException
      err.code = 'EXDEV'
      throw err
    })

    const result = await relocateLibrary(fromDir, toDir, ['a.mp4', 'a.json'])

    expect(result).toMatchObject({ moved: true, count: 2, crossDevice: true })
    expect(await readFile(join(toDir, 'a.mp4'), 'utf8')).toBe('video-bytes')
    expect(await readFile(join(toDir, 'a.json'), 'utf8')).toBe('{"sidecar":true}')
    expect(await names(fromDir)).toEqual(['a.json', 'a.mp4'])
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

  it('rejects portable aliases in the incoming catalog before moving either entry', async () => {
    await seed(fromDir, 'Take.mp4', 'video-a')

    await expect(relocateLibrary(fromDir, toDir, ['Take.mp4', 'take.MP4'])).rejects.toThrow(/already contains/)

    expect(await readFile(join(fromDir, 'Take.mp4'), 'utf8')).toBe('video-a')
    expect(await names(toDir)).toEqual([])
  })

  it('rolls back exact claims when a late destination winner appears partway', async () => {
    await seed(fromDir, 'a.mp4', 'video-a')
    await seed(fromDir, 'b.mp4', 'video-b')
    await seed(fromDir, 'c.mp4', 'video-c')

    // The preflight sees an empty destination. Insert a winner only at b.mp4's
    // final publication edge, after a.mp4 has moved, so a rolls back and the winner
    // is preserved.
    linkSpy.mockImplementation(async (src, dest) => {
      if (String(dest) === join(toDir, 'b.mp4')) {
        await writeFile(dest, 'late winner')
      }
      return realFsPromises.link(src, dest)
    })

    await expect(relocateLibrary(fromDir, toDir, ['a.mp4', 'b.mp4', 'c.mp4'])).rejects.toMatchObject({ code: 'EEXIST' })

    // Every source stayed public throughout; only the external winner remains at
    // the destination after exact rollback of the transaction's earlier claims.
    expect(mp4s(await names(fromDir))).toEqual(['a.mp4', 'b.mp4', 'c.mp4'])
    expect(await readFile(join(fromDir, 'a.mp4'), 'utf8')).toBe('video-a')
    expect(mp4s(await names(toDir))).toEqual(['b.mp4'])
    expect(await readFile(join(toDir, 'b.mp4'), 'utf8')).toBe('late winner')
  })

  it('preserves a destination replacement winner during pre-config rollback', async () => {
    await seed(fromDir, 'a.mp4', 'moved library file')
    const result = await relocateLibrary(fromDir, toDir, ['a.mp4'])
    if (!result.moved) throw new Error('fixture did not publish')
    await writeFile(join(root, 'destination-winner.tmp'), 'destination winner')
    await realFsPromises.rename(join(root, 'destination-winner.tmp'), join(toDir, 'a.mp4'))

    await expect(rollbackLibraryRelocation(result.files)).rejects.toThrow(/could not be cleaned up/)

    expect(await readFile(join(fromDir, 'a.mp4'), 'utf8')).toBe('moved library file')
    expect(await readFile(join(toDir, 'a.mp4'), 'utf8')).toBe('destination winner')
  })

  it('keeps every source readable at a partial-publication process boundary', async () => {
    await seed(fromDir, 'a.mp4', 'video-a')
    await seed(fromDir, 'b.mp4', 'video-b')
    let signalPaused!: () => void
    let resume!: () => void
    const paused = new Promise<void>((resolve) => { signalPaused = resolve })
    const resumed = new Promise<void>((resolve) => { resume = resolve })
    linkSpy.mockImplementation(async (src, dest) => {
      if (String(dest) === join(toDir, 'b.mp4')) {
        signalPaused()
        await resumed
      }
      return realFsPromises.link(src, dest)
    })

    const relocation = relocateLibrary(fromDir, toDir, ['a.mp4', 'b.mp4'])
    await paused

    // If the process stopped here, config.json would still name fromDir and both
    // catalog-visible source paths remain complete despite partial publication.
    expect(await readFile(join(fromDir, 'a.mp4'), 'utf8')).toBe('video-a')
    expect(await readFile(join(fromDir, 'b.mp4'), 'utf8')).toBe('video-b')
    expect(await readFile(join(toDir, 'a.mp4'), 'utf8')).toBe('video-a')
    expect(await exists(join(toDir, 'b.mp4'))).toBe(false)

    resume()
    const result = await relocation
    if (!result.moved) throw new Error('fixture did not publish')

    // Complete publication is also pre-config: old authority still resolves every
    // source until the caller explicitly completes after the durable settings save.
    expect(await names(fromDir)).toEqual(['a.mp4', 'b.mp4'])
    expect(await readFile(join(toDir, 'b.mp4'), 'utf8')).toBe('video-b')
  })
})
