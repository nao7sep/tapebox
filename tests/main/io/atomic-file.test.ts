import { access, chmod, link, lstat, mkdtemp, open, readFile, readdir, rename, rm, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  publishFileNoOverwrite,
  claimFile,
  relocateClaimedFileNoOverwrite,
  unlinkClaimedFile,
  type ExclusivePublishDestination,
  type ExclusivePublishOperations,
  type ExclusivePublishSource,
  writeFileAtomicNoOverwriteVia,
  writeFileAtomicVia,
} from '@main/io/atomic-file'

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
  }
  const destination: ExclusivePublishDestination = {
    write: vi.fn(async (buffer, offset, length) => {
      published.push(Buffer.from(buffer.subarray(offset, offset + length)))
      return { bytesWritten: length }
    }),
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
      }
    },
    openExclusive: async (path) => {
      const handle = await open(path, 'wx')
      return {
        write: (buffer, offset, length, position) => handle.write(buffer, offset, length, position),
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
    const signal = {
      throwIfAborted() {
        checks += 1
        if (checks === 2) throw new DOMException('cancel before publish', 'AbortError')
      },
    } as AbortSignal

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

describe('writeFileAtomicNoOverwriteVia', () => {
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
    const bytes = Buffer.alloc(600_000, 0x5a)
    await writeFile(temp, bytes)
    const fixture = memoryPublishOperations(bytes, {
      link: vi.fn().mockRejectedValue(failure('ENOTSUP')),
    })

    await publishFileNoOverwrite(temp, join(dir, 'output.bin'), fixture.operations)

    expect(Buffer.concat(fixture.published)).toEqual(bytes)
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
    const operations = realOperations({
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
        const opened = await realOperations().openRead(path)
        if (path === source) {
          const winner = join(dir, 'late-source-winner.bin')
          await writeFile(winner, 'late source winner')
          await rename(winner, source)
        }
        return opened
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
