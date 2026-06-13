import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { writeFileAtomicVia } from '@main/io/atomic-file'

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

describe('writeFileAtomicVia', () => {
  it('publishes produced content to destPath and removes the temp', async () => {
    const dest = join(dir, 'binary')
    let seenTemp = ''

    await writeFileAtomicVia(dest, async (tmp) => {
      seenTemp = tmp
      await writeFile(tmp, 'hello')
    })

    expect(await readFile(dest, 'utf8')).toBe('hello')
    expect(seenTemp).toBe(`${dest}.partial`)
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

    await expect(
      writeFileAtomicVia(dest, async (tmp) => {
        await writeFile(tmp, 'half-written')
        throw new Error('produce failed')
      }),
    ).rejects.toThrow('produce failed')

    expect(await readFile(dest, 'utf8')).toBe('original')
    expect(await exists(`${dest}.partial`)).toBe(false)
  })

  it('creates no destPath when produce throws and none existed', async () => {
    const dest = join(dir, 'binary')

    await expect(
      writeFileAtomicVia(dest, async (tmp) => {
        await writeFile(tmp, 'x')
        throw new Error('boom')
      }),
    ).rejects.toThrow('boom')

    expect(await exists(dest)).toBe(false)
    expect(await exists(`${dest}.partial`)).toBe(false)
  })

  it('honors a caller-supplied temp path (e.g. an extension the producer needs)', async () => {
    const dest = join(dir, 'poster.jpg')
    const customTemp = join(dir, 'poster.staging.jpg')
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
    const customTemp = join(dir, 'poster.staging.jpg')

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
})
