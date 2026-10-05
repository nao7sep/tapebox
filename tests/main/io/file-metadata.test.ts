import { describe, expect, it, vi } from 'vitest'

import { applyFileStamp, type FileStamp, type StampTarget } from '@main/io/file-metadata'

// The permissions and times a copy takes from its source. The real-filesystem
// path through the copy primitive is covered in atomic-file.test.ts.

const STAMP: FileStamp = { mode: 0o640, atime: 1_700_000_000, mtime: 1_600_000_000, birthtime: 1_500_000_000 }

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
  it('on macOS sets the birth time through an earlier modified time, then the real times', async () => {
    const copy = target()
    await applyFileStamp(copy, STAMP, 'darwin')
    expect(copy.calls).toEqual(['chmod 640', 'utimes 1700000000 1500000000', 'utimes 1700000000 1600000000'])
  })

  it('elsewhere sets the access and modified times only', async () => {
    const copy = target()
    await applyFileStamp(copy, STAMP, 'win32')
    expect(copy.calls).toEqual(['chmod 640', 'utimes 1700000000 1600000000'])
  })

  it('does not move a birth time that is not earlier than the modified time', async () => {
    const copy = target()
    await applyFileStamp(copy, { ...STAMP, birthtime: STAMP.mtime }, 'darwin')
    expect(copy.calls).toEqual(['chmod 640', 'utimes 1700000000 1600000000'])
  })

  it('drops permissions the volume refuses and still keeps the times', async () => {
    const copy = target(failure('EPERM'))
    await applyFileStamp(copy, STAMP, 'win32')
    expect(copy.calls).toEqual(['chmod 640', 'utimes 1700000000 1600000000'])
  })

  it('fails on any other permission error', async () => {
    await expect(applyFileStamp(target(failure('EIO')), STAMP, 'win32')).rejects.toMatchObject({ code: 'EIO' })
  })

  it('fails when the modified time cannot be set', async () => {
    const copy = target()
    vi.mocked(copy.utimes).mockRejectedValue(failure('EIO'))
    await expect(applyFileStamp(copy, STAMP, 'win32')).rejects.toMatchObject({ code: 'EIO' })
  })
})
