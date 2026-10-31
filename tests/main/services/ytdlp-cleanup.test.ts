import { join } from 'node:path'
import { beforeEach, expect, it, vi } from 'vitest'

const { readdir, unlink, spawnStreaming } = vi.hoisted(() => ({
  readdir: vi.fn(), unlink: vi.fn(), spawnStreaming: vi.fn(),
}))
vi.mock('node:fs/promises', async (original) => ({
  ...await original<typeof import('node:fs/promises')>(), readdir, unlink,
}))
vi.mock('@main/io/spawn', async (original) => ({
  ...await original<typeof import('@main/io/spawn')>(), spawnStreaming,
}))
import { clearStem, download } from '@main/services/ytdlp'

beforeEach(() => {
  vi.clearAllMocks()
  readdir.mockResolvedValue(['tape.part', 'other.part'])
  unlink.mockResolvedValue(undefined)
})

it.each(['EACCES', 'EBUSY'])('does not launch a download when required cleanup fails with %s', async (code) => {
  const failure = Object.assign(new Error('held fragment'), { code })
  unlink.mockRejectedValueOnce(failure)
  await expect(download({ tapeId: 'tape', outputId: 'tape', dir: '/collection', url: 'https://example.test', signal: new AbortController().signal })).rejects.toBe(failure)
  expect(spawnStreaming).not.toHaveBeenCalled()
})

it('propagates a directory read failure before starting the downloader', async () => {
  const failure = Object.assign(new Error('unreadable directory'), { code: 'EIO' })
  readdir.mockRejectedValueOnce(failure)
  await expect(download({ tapeId: 'tape', outputId: 'tape', dir: '/collection', url: 'https://example.test', signal: new AbortController().signal })).rejects.toBe(failure)
  expect(unlink).not.toHaveBeenCalled()
  expect(spawnStreaming).not.toHaveBeenCalled()
})

it('tolerates a fragment disappearing and leaves other namespaces alone', async () => {
  unlink.mockRejectedValueOnce(Object.assign(new Error('gone'), { code: 'ENOENT' }))
  await clearStem('/collection', 'tape')
  expect(unlink).toHaveBeenCalledExactlyOnceWith(join('/collection', 'tape.part'))
})

it('accepts an already absent namespace', async () => {
  readdir.mockRejectedValueOnce(Object.assign(new Error('gone'), { code: 'ENOENT' }))
  await clearStem('/collection', 'tape')
  expect(unlink).not.toHaveBeenCalled()
})
