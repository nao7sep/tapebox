import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@main/paths', () => ({
  paths: { dependencies: '/mock/.tapebox/dependencies.json' },
}))

vi.mock('@main/io/atomic-json', () => ({
  writeJsonAtomic: vi.fn(async () => {}),
  writeManagedJson: vi.fn(async () => {}),
}))

vi.mock('@main/io/logger', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))

import { writeJsonAtomic, writeManagedJson } from '@main/io/atomic-json'
import { loadDependencies, mutateDependencies } from '@main/store/dependencies'

beforeEach(async () => {
  vi.clearAllMocks()
  await loadDependencies()
})

describe('dependency facts persistence', () => {
  it('uses the unrecorded atomic writer for re-derivable update facts', async () => {
    await mutateDependencies(() => ({
      ffmpeg: {
        latestKnownVersion: '2026-08-22',
        lastCheckedAtUtc: '2026-08-22T00:00:00.000Z',
      },
    }))

    expect(writeJsonAtomic).toHaveBeenCalledOnce()
    expect(writeJsonAtomic).toHaveBeenCalledWith(
      '/mock/.tapebox/dependencies.json',
      expect.objectContaining({
        ffmpeg: {
          latestKnownVersion: '2026-08-22',
          lastCheckedAtUtc: '2026-08-22T00:00:00.000Z',
        },
      }),
      expect.anything(),
    )
    expect(writeManagedJson).not.toHaveBeenCalled()
  })
})
