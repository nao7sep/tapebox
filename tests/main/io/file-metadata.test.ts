import { describe, expect, it, vi } from 'vitest'

import { applyFileStamp, type FileStamp, type StampTarget } from '@main/io/file-metadata'

// The permissions and times a copy takes from its source. The real-filesystem
// path through the copy primitive is covered in atomic-file.test.ts.

const STAMP: FileStamp = { mode: 0o640, atime: 1_700_000_000, mtime: 1_600_000_000 }

function target(chmodError?: NodeJS.ErrnoException): StampTarget & { calls: string[] } {
  const calls: string[] = []
  return {
    calls,
    chmod: vi.fn(async (mode: number) => {
      calls.push(`chmod ${mode.toString(8)}`)
      if (chmodError) throw chmodError
    }),
    utimes: vi.fn(async (atime: number, mtime: number) => {
      calls.push(`utimes ${atime} ${mtime}`)
    }),
  }
}

function failure(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(code), { code })
}

describe('applyFileStamp', () => {
  it('applies ordinary permissions and access/modified times once', async () => {
    const copy = target()
    await applyFileStamp(copy, STAMP)
    expect(copy.calls).toEqual(['chmod 640', 'utimes 1700000000 1600000000'])
  })

  it('drops permissions the volume refuses and still keeps the times', async () => {
    const copy = target(failure('EPERM'))
    await applyFileStamp(copy, STAMP)
    expect(copy.calls).toEqual(['chmod 640', 'utimes 1700000000 1600000000'])
  })

  it('fails on any other permission error', async () => {
    await expect(applyFileStamp(target(failure('EIO')), STAMP)).rejects.toMatchObject({ code: 'EIO' })
  })

  it('fails when the modified time cannot be set', async () => {
    const copy = target()
    vi.mocked(copy.utimes).mockRejectedValue(failure('EIO'))
    await expect(applyFileStamp(copy, STAMP)).rejects.toMatchObject({ code: 'EIO' })
  })
})
