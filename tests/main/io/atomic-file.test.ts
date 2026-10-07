import * as fileIo from 'node:fs/promises'
import { access, chmod, link, lstat, mkdtemp, open, readFile, readdir, rename, rm, stat, unlink, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  publishFileNoOverwrite,
  claimFile,
  copyFileNoOverwrite,
  directorySupportsHardLinks,
  relocateClaimedFileNoOverwrite,
  unlinkClaimedFile,
  type ExclusivePublishDestination,
  type ExclusivePublishOperations,
  type ExclusivePublishSource,
  writeFileAtomicNoOverwriteVia,
  writeFileAtomicVia,
} from '@main/io/atomic-file'
import { fileStampOf, type FileStamp } from '@main/io/file-metadata'

vi.mock('node:fs/promises', async (importOriginal) => ({ ...await importOriginal<typeof import('node:fs/promises')>() }))

// Real filesystem (a temp dir) so the temp → fsync → rename → cleanup is actually
// exercised end to end; the producer is the seam every caller plugs into.

let dir: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'tapebox-atomic-'))
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

const STAMP: FileStamp = { mode: 0o644, atime: 1_600_000_000, mtime: 1_600_000_000 }

function failure(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(code), { code })
}

function memoryPublishOperations(
  sourceBytes: Buffer,
  overrides: Partial<ExclusivePublishOperations> = {},
): { operations: ExclusivePublishOperations; published: Buffer[]; readLengths: number[] } {
  const published: Buffer[] = []
  const readLengths: number[] = []
  const source: ExclusivePublishSource = {
    read: vi.fn(async (buffer, offset, length, position) => {
      readLengths.push(length)
      const bytesRead = Math.min(length, Math.max(0, sourceBytes.length - position))
      sourceBytes.copy(buffer, offset, position, position + bytesRead)
      return { bytesRead }
    }),
    close: vi.fn().mockResolvedValue(undefined),
    identity: vi.fn().mockResolvedValue('claim'),
    stamp: vi.fn().mockResolvedValue(STAMP),
  }
  const destination: ExclusivePublishDestination = {
    write: vi.fn(async (buffer, offset, length) => {
      published.push(Buffer.from(buffer.subarray(offset, offset + length)))
      return { bytesWritten: length }
    }),
    chmod: vi.fn().mockResolvedValue(undefined),
    utimes: vi.fn().mockResolvedValue(undefined),
    sync: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
    identity: vi.fn().mockResolvedValue('claim'),
  }
  return {
    published,
    readLengths,
    operations: {
      link: vi.fn().mockResolvedValue(undefined),
      rename: vi.fn().mockResolvedValue(undefined),
      openRead: vi.fn().mockResolvedValue(source),
      openExclusive: vi.fn().mockResolvedValue(destination),
      pathIdentity: vi.fn().mockResolvedValue('claim'),
      unlink: vi.fn().mockResolvedValue(undefined),
      ...overrides,
    },
  }
}

function realOperations(
  overrides: Partial<ExclusivePublishOperations> = {},
): ExclusivePublishOperations {
  return {
    link,
    rename,
    openRead: async (path) => {
      const handle = await open(path, 'r')
      return {
        read: (buffer, offset, length, position) => handle.read(buffer, offset, length, position),
        close: () => handle.close(),
        identity: async () => {
          const value = await handle.stat({ bigint: true })
          return `${value.dev}:${value.ino}`
        },
        stamp: async () => fileStampOf(await handle.stat({ bigint: true })),
      }
    },
    openExclusive: async (path) => {
      const handle = await open(path, 'wx')
      return {
        write: (buffer, offset, length, position) => handle.write(buffer, offset, length, position),
        chmod: (mode) => handle.chmod(mode),
        utimes: (atime, mtime) => handle.utimes(atime, mtime),
        sync: () => handle.sync(),
        close: () => handle.close(),
        identity: async () => {
          const value = await handle.stat({ bigint: true })
          return `${value.dev}:${value.ino}`
        },
      }
    },
    pathIdentity: async (path) => {
      try {
        const value = await lstat(path, { bigint: true })
        return `${value.dev}:${value.ino}`
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null
        throw err
      }
    },
    unlink,
    ...overrides,
  }
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

  it('leaves a colliding export stage untouched when exclusive creation fails', async () => {
    const dest = join(dir, 'export.json')
    const stage = join(dir, 'foreign.tmp')
    await writeFile(stage, 'foreign content')
    const produce = vi.fn(async () => {})
    await expect(writeFileAtomicNoOverwriteVia(dest, produce, stage)).rejects.toMatchObject({ code: 'EEXIST' })
    expect(produce).not.toHaveBeenCalled()
    expect(await readFile(stage, 'utf8')).toBe('foreign content')
    expect(await exists(dest)).toBe(false)
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

describe('portable no-overwrite publication', () => {
  it('uses a bounded exclusive copy when the filesystem rejects hard links', async () => {
    const temp = join(dir, 'stage.bin')
    const bytes = Buffer.alloc(256 * 1024 + 1, 0x5a)
    await writeFile(temp, bytes)
    const fixture = memoryPublishOperations(bytes, {
      link: vi.fn().mockRejectedValue(failure('ENOTSUP')),
    })

    await publishFileNoOverwrite(temp, join(dir, 'output.bin'), fixture.operations)

    expect(Buffer.concat(fixture.published).equals(bytes)).toBe(true)
    expect(Math.max(...fixture.readLengths)).toBeLessThanOrEqual(256 * 1024)
    expect(fixture.operations.unlink).toHaveBeenCalledWith(temp)
  })

  it('preserves a replacement arriving at fallback failure cleanup', async () => {
    const temp = join(dir, 'stage.bin')
    const destination = join(dir, 'output.bin')
    const winner = join(dir, 'winner.bin')
    await writeFile(temp, 'complete bytes')
    const base = realOperations()
    let replaced = false
    const operations = realOperations({
      link: async (from, to) => {
        if (from === temp && to === destination) throw failure('ENOTSUP')
        await base.link(from, to)
      },
      openExclusive: async (path) => {
        const opened = await base.openExclusive(path)
        return {
          ...opened,
          write: async (buffer, offset, length, position) => {
            await opened.write(buffer, offset, Math.min(3, length), position)
            throw failure('ENOSPC')
          },
        }
      },
      rename: async (from, to) => {
        if (!replaced && from === destination) {
          replaced = true
          await writeFile(winner, 'external winner')
          await rename(winner, destination)
        }
        await rename(from, to)
      },
    })

    await expect(publishFileNoOverwrite(temp, destination, operations)).rejects.toMatchObject({ code: 'EEXIST' })

    expect(await readFile(destination, 'utf8')).toBe('external winner')
    expect(await readFile(temp, 'utf8')).toBe('complete bytes')
  })

  it('surfaces failed EXDEV destination cleanup and restores the source claim', async () => {
    const source = join(dir, 'source.bin')
    const destination = join(dir, 'destination.bin')
    await writeFile(source, 'source bytes')
    const base = realOperations()
    const operations = realOperations({
      link: async (from, to) => {
        if (to === destination) throw failure('EXDEV')
        await base.link(from, to)
      },
      openExclusive: async (path) => {
        const opened = await base.openExclusive(path)
        return {
          ...opened,
          write: async (buffer, offset, length, position) => {
            await opened.write(buffer, offset, Math.min(3, length), position)
            throw failure('ENOSPC')
          },
        }
      },
      rename: async (from, to) => {
        if (from === destination) throw failure('EACCES')
        await rename(from, to)
      },
    })

    await expect(
      relocateClaimedFileNoOverwrite(await claimFile(source), destination, operations),
    ).rejects.toThrow(/destination claim could not be cleaned up/)

    expect(await readFile(source, 'utf8')).toBe('source bytes')
    expect(await readFile(destination, 'utf8')).toBe('sou')
  })
})

describe('physical claim transitions', () => {
  it('relocates an existing read-only file without requiring write access to its source handle', async () => {
    const source = join(dir, 'read-only.bin')
    const destination = join(dir, 'moved.bin')
    await writeFile(source, 'source')
    await chmod(source, 0o444)

    const moved = await relocateClaimedFileNoOverwrite(await claimFile(source), destination)

    expect(moved).not.toBeNull()
    expect(await readFile(destination, 'utf8')).toBe('source')
  })

  it('preserves a winner that replaces a claim at the exact removal boundary', async () => {
    const path = join(dir, 'claimed.bin')
    const winnerTemp = join(dir, 'winner.bin')
    await writeFile(path, 'ours')
    await writeFile(winnerTemp, 'winner')
    const claim = await claimFile(path)
    let replaced = false
    const operations = realOperations({
      rename: async (from, to) => {
        if (!replaced && from === path) {
          replaced = true
          await rename(winnerTemp, path)
        }
        await rename(from, to)
      },
    })

    await expect(unlinkClaimedFile(claim, operations)).resolves.toBe(false)

    expect(await readFile(path, 'utf8')).toBe('winner')
    expect((await readdir(dir)).filter((name) => name.endsWith('.tmp'))).toEqual([])
  })

  it('refuses a late relocation destination and restores the exact source claim', async () => {
    const source = join(dir, 'source.bin')
    const destination = join(dir, 'destination.bin')
    await writeFile(source, 'source')
    const claim = await claimFile(source)
    let insertedWinner = false
    const stageRename = vi.fn(rename)
    const operations = realOperations({
      rename: stageRename,
      link: async (from, to) => {
        if (!insertedWinner && to === destination) {
          insertedWinner = true
          await writeFile(destination, 'winner')
        }
        await link(from, to)
      },
    })

    await expect(relocateClaimedFileNoOverwrite(claim, destination, operations)).rejects.toMatchObject({
      code: 'EEXIST',
    })

    expect(await readFile(source, 'utf8')).toBe('source')
    expect(await readFile(destination, 'utf8')).toBe('winner')
    expect((await readdir(dir)).filter((name) => name.endsWith('.tmp'))).toEqual([])
    expect(stageRename).not.toHaveBeenCalled()
  })

  it('reports publication and owned-stage cleanup failures while retaining the public source', async () => {
    const source = join(dir, 'source.bin')
    const destination = join(dir, 'destination.bin')
    await writeFile(source, 'source')
    await writeFile(destination, 'winner')
    const publicationError = failure('EEXIST')
    const cleanupError = failure('EACCES')
    const operations = realOperations({
      link: async (from, to) => {
        if (to === destination) throw publicationError
        await link(from, to)
      },
      unlink: async () => { throw cleanupError },
    })

    const error = await relocateClaimedFileNoOverwrite(await claimFile(source), destination, operations)
      .catch((err: unknown) => err)

    expect(error).toBeInstanceOf(AggregateError)
    expect((error as AggregateError).errors).toEqual([publicationError, cleanupError])
    expect(await readFile(source, 'utf8')).toBe('source')
    expect(await readFile(destination, 'utf8')).toBe('winner')
    const stages = (await readdir(dir)).filter((name) => name.endsWith('.tmp'))
    expect(stages).toHaveLength(1)
    expect(await readFile(join(dir, stages[0]!), 'utf8')).toBe('source')
  })

  it('does not publish a source winner linked at the same-filesystem bind boundary', async () => {
    const source = join(dir, 'source.bin')
    const destination = join(dir, 'destination.bin')
    const winner = join(dir, 'winner.bin')
    await writeFile(source, 'original')
    await writeFile(winner, 'replacement winner')
    const claim = await claimFile(source)
    let replaced = false
    const operations = realOperations({
      link: async (from, to) => {
        if (!replaced && from === source) {
          replaced = true
          await rename(winner, source)
        }
        await link(from, to)
      },
    })

    await expect(relocateClaimedFileNoOverwrite(claim, destination, operations)).resolves.toBeNull()

    expect(await readFile(source, 'utf8')).toBe('replacement winner')
    expect(await exists(destination)).toBe(false)
    expect((await readdir(dir)).filter((name) => name.endsWith('.tmp'))).toEqual([])
  })

  it('never removes a late source winner during the cross-device copy fallback', async () => {
    const source = join(dir, 'source.bin')
    const destination = join(dir, 'destination.bin')
    await writeFile(source, 'source')
    const claim = await claimFile(source)
    const operations = realOperations({
      link: async () => {
        throw failure('EXDEV')
      },
      openRead: async (path) => {
        if (path !== source) return realOperations().openRead(path)

        // Model the stable opened source independently of the public pathname.
        // Windows does not allow replacing a pathname while its ordinary Node
        // handle remains open, whereas POSIX does; the injected operation keeps
        // the same ownership race portable without weakening the assertion.
        const bytes = await readFile(path)
        const winner = join(dir, 'late-source-winner.bin')
        await writeFile(winner, 'late source winner')
        await rename(winner, source)
        return {
          read: async (buffer: Buffer, offset: number, length: number, position: number) => {
            const bytesRead = Math.min(length, Math.max(0, bytes.length - position))
            bytes.copy(buffer, offset, position, position + bytesRead)
            return { bytesRead }
          },
          close: async () => {},
          identity: async () => claim.identity,
          stamp: async () => STAMP,
        }
      },
    })

    const moved = await relocateClaimedFileNoOverwrite(claim, destination, operations)

    expect(moved?.crossDevice).toBe(true)
    expect(await readFile(destination, 'utf8')).toBe('source')
    expect(await readFile(source, 'utf8')).toBe('late source winner')
  })

  it('refuses to copy a replacement opened after the original source claim changed', async () => {
    const source = join(dir, 'source.bin')
    const destination = join(dir, 'destination.bin')
    const winner = join(dir, 'winner.bin')
    await writeFile(source, 'original')
    await writeFile(winner, 'replacement winner')
    const claim = await claimFile(source)
    const base = realOperations()
    const operations = realOperations({
      link: async () => {
        await rename(winner, source)
        throw failure('EXDEV')
      },
      openRead: (path) => base.openRead(path),
    })

    await expect(relocateClaimedFileNoOverwrite(claim, destination, operations)).rejects.toMatchObject({
      code: 'EEXIST',
    })

    expect(await readFile(source, 'utf8')).toBe('replacement winner')
    expect(await exists(destination)).toBe(false)
  })

  it('keeps the catalog-visible source readable throughout a cross-device copy', async () => {
    const source = join(dir, 'source.bin')
    const destination = join(dir, 'destination.bin')
    await writeFile(source, Buffer.alloc(600_000, 0x51))
    const base = realOperations()
    let signalStarted!: () => void
    let resumeCopy!: () => void
    const started = new Promise<void>((resolve) => { signalStarted = resolve })
    const paused = new Promise<void>((resolve) => { resumeCopy = resolve })
    let firstWrite = true
    const operations = realOperations({
      link: async () => {
        throw failure('EXDEV')
      },
      openExclusive: async (path) => {
        const opened = await base.openExclusive(path)
        return {
          ...opened,
          write: async (buffer, offset, length, position) => {
            if (firstWrite) {
              firstWrite = false
              signalStarted()
              await paused
            }
            return opened.write(buffer, offset, length, position)
          },
        }
      },
    })

    const relocation = relocateClaimedFileNoOverwrite(await claimFile(source), destination, operations)
    await started

    // This is the orchestration state that matters for crash safety: if the
    // process stopped here, catalog.json would still resolve to the complete file.
    expect((await readFile(source)).length).toBe(600_000)
    resumeCopy()

    await expect(relocation).resolves.toMatchObject({ crossDevice: true })
    expect(await exists(source)).toBe(false)
    expect((await readFile(destination)).length).toBe(600_000)
  })
})

describe('single-pass no-overwrite copy', () => {
  it('writes every byte once, straight into the final claim, where hard links are unavailable', async () => {
    const source = join(dir, 'source.bin')
    const bytes = Buffer.alloc(256 * 1024 * 2 + 7, 0x33)
    await writeFile(source, bytes)
    const fixture = memoryPublishOperations(bytes, {
      link: vi.fn().mockRejectedValue(failure('ENOTSUP')),
    })

    const destination = join(dir, 'output.bin')
    await copyFileNoOverwrite(source, destination, { hardLinks: false }, fixture.operations)

    expect(Buffer.concat(fixture.published).equals(bytes)).toBe(true)
    expect(fixture.operations.openExclusive).toHaveBeenCalledTimes(1)
    expect(fixture.operations.openExclusive).toHaveBeenCalledWith(destination)
    expect(fixture.operations.link).not.toHaveBeenCalled()
  })

  it('gives the claim ordinary permissions and copy times before syncing', async () => {
    const source = join(dir, 'source.bin')
    const bytes = Buffer.from('bytes')
    await writeFile(source, bytes)
    const fixture = memoryPublishOperations(bytes)
    const destination = join(dir, 'output.bin')

    await copyFileNoOverwrite(source, destination, { hardLinks: false }, fixture.operations)

    const opened = await vi.mocked(fixture.operations.openExclusive).mock.results[0]!.value as ExclusivePublishDestination
    expect(opened.chmod).toHaveBeenCalledWith(STAMP.mode)
    expect(opened.utimes).toHaveBeenLastCalledWith(STAMP.atime, STAMP.mtime)
    expect(vi.mocked(opened.utimes).mock.invocationCallOrder.at(-1)!)
      .toBeGreaterThan(vi.mocked(opened.chmod).mock.invocationCallOrder[0]!)
    expect(vi.mocked(opened.sync).mock.invocationCallOrder[0]!)
      .toBeGreaterThan(vi.mocked(opened.utimes).mock.invocationCallOrder.at(-1)!)
  })

  for (const hardLinks of [true, false]) {
    it(`keeps the source's content, modified time and ordinary permissions (hard links: ${hardLinks})`, async () => {
      const source = join(dir, 'source.bin')
      await writeFile(source, 'video bytes')
      const modified = new Date('2020-08-09T10:11:12.000Z')
      await utimes(source, modified, modified)
      if (process.platform !== 'win32') await chmod(source, 0o640)
      const destination = join(dir, 'copy.bin')

      await copyFileNoOverwrite(source, destination, { hardLinks })

      const copied = await stat(destination)
      expect(copied.mtimeMs).toBe(modified.getTime())
      expect(await readFile(destination, 'utf8')).toBe('video bytes')
      if (process.platform !== 'win32') expect(copied.mode & 0o777).toBe(0o640)
      expect((await readdir(dir)).sort()).toEqual(['copy.bin', 'source.bin'])
    })
  }

  it('claims the file by the id it has once its content is written, as FAT ids change on the first write', async () => {
    const source = join(dir, 'source.bin')
    const bytes = Buffer.from('content')
    await writeFile(source, bytes)
    let wrote = false
    const fixture = memoryPublishOperations(bytes, {
      openExclusive: vi.fn(async () => ({
        write: async (_buffer: Buffer, _offset: number, length: number) => {
          wrote = true
          return { bytesWritten: length }
        },
        chmod: async () => {},
        utimes: async () => {},
        sync: async () => {},
        close: async () => {},
        identity: async () => (wrote ? 'cluster-7' : 'entry-3'),
      })),
      pathIdentity: vi.fn(async (path: string) => (path === source ? 'claim' : wrote ? 'cluster-7' : 'entry-3')),
    })

    const claim = await copyFileNoOverwrite(source, join(dir, 'output.bin'), { hardLinks: false }, fixture.operations)

    expect(claim.identity).toBe('cluster-7')
    expect(fixture.operations.rename, 'nothing was taken for a replacement and moved aside').not.toHaveBeenCalled()
  })

  it('stages in a sibling temp and links it into place where hard links work', async () => {
    const source = join(dir, 'source.bin')
    await writeFile(source, Buffer.alloc(300_000, 0x44))
    const destination = join(dir, 'output.bin')

    const claim = await copyFileNoOverwrite(source, destination, { hardLinks: await directorySupportsHardLinks(dir) })

    expect(claim.path).toBe(destination)
    expect((await readFile(destination)).length).toBe(300_000)
    expect((await readdir(dir)).sort()).toEqual(['output.bin', 'source.bin'])
  })

  for (const hardLinks of [true, false]) {
    it(`an abort mid-copy leaves nothing under the final name (hard links: ${hardLinks})`, async () => {
      const source = join(dir, 'source.bin')
      await writeFile(source, Buffer.alloc(600_000, 0x55))
      const destination = join(dir, 'output.bin')
      const controller = new AbortController()
      const base = realOperations()
      let writes = 0
      const operations = realOperations({
        openExclusive: async (path) => {
          const opened = await base.openExclusive(path)
          return {
            ...opened,
            write: async (buffer, offset, length, position) => {
              writes += 1
              if (writes === 1) controller.abort()
              return opened.write(buffer, offset, length, position)
            },
          }
        },
      })

      await expect(copyFileNoOverwrite(source, destination, { hardLinks, signal: controller.signal }, operations))
        .rejects.toThrow()

      expect(await exists(destination)).toBe(false)
      expect(await readdir(dir)).toEqual(['source.bin'])
    })
  }

  it('never names a cross-device copy in progress with its final name when the destination links', async () => {
    const source = join(dir, 'source.bin')
    const destination = join(dir, 'destination.bin')
    await writeFile(source, Buffer.alloc(600_000, 0x61))
    const base = realOperations()
    let signalStarted!: () => void
    let resumeCopy!: () => void
    const started = new Promise<void>((resolve) => { signalStarted = resolve })
    const paused = new Promise<void>((resolve) => { resumeCopy = resolve })
    let firstWrite = true
    const operations = realOperations({
      // Only the source cannot be linked (another device); the destination can.
      link: async (from, to) => {
        if (from === source) throw failure('EXDEV')
        return link(from, to)
      },
      openExclusive: async (path) => {
        const opened = await base.openExclusive(path)
        return {
          ...opened,
          write: async (buffer, offset, length, position) => {
            if (firstWrite) {
              firstWrite = false
              signalStarted()
              await paused
            }
            return opened.write(buffer, offset, length, position)
          },
        }
      },
    })

    const relocation = relocateClaimedFileNoOverwrite(await claimFile(source), destination, operations)
    await started
    expect(await exists(destination)).toBe(false)
    resumeCopy()

    await expect(relocation).resolves.toMatchObject({ crossDevice: true })
    expect((await readFile(destination)).length).toBe(600_000)
    expect(await readdir(dir)).toEqual(['destination.bin'])
  })
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
