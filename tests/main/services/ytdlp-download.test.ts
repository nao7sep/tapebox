import { EventEmitter } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { writeRecord, writeOutputChunk, spawnStreaming } = vi.hoisted(() => ({ writeRecord: vi.fn(), writeOutputChunk: vi.fn(), spawnStreaming: vi.fn() }))
vi.mock('@main/io/records', () => ({ writeRecord, writeOutputChunk }))
vi.mock('@main/paths', () => ({ binaryPath: () => '/bin/yt-dlp', paths: { bin: '/bin' } }))
vi.mock('@main/services/ytdlp-args', () => ({ resolveYtdlpArgs: () => [] }))
vi.mock('@main/io/spawn', async (original) => ({ ...await original<object>(), spawnStreaming }))

import { download } from '@main/services/ytdlp'

let dir: string
let child: EventEmitter & { stdout: PassThrough; stderr: PassThrough }

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'tapebox-download-'))
  child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough() })
  spawnStreaming.mockReset().mockReturnValue(child)
  writeRecord.mockClear()
    writeOutputChunk.mockClear()
})

afterEach(async () => {
  child.stdout.destroy()
  child.stderr.destroy()
  await rm(dir, { recursive: true, force: true })
})

describe('download output lines', () => {
  it('keeps a partial stderr progress line separate from a complete stdout final path', async () => {
    const onProgress = vi.fn()
    const onLog = vi.fn()
    const mediaPath = join(dir, 'output.mp4')
    const result = download({ tapeId: 't1', url: 'https://example.test/v', libraryDir: dir, outputId: 'output', onProgress, onLog, signal: new AbortController().signal })
    await vi.waitFor(() => expect(spawnStreaming).toHaveBeenCalledOnce())

    child.stderr.write('tapebox-progress:50')
    child.stdout.write(`tapebox-final-filepath:${mediaPath}\n`)
    child.stderr.write('.0%|12|3\n[download] stderr tail')
    child.stdout.write('[download] stdout tail')
    child.emit('close', 0, null)

    await expect(result).resolves.toEqual({ mediaPath, infoJsonPath: join(dir, 'output.info.json') })
    expect(onProgress).toHaveBeenCalledExactlyOnceWith({ percent: 50, speedBps: 12, etaSec: 3 })
    expect(onLog.mock.calls.map(([line]) => line)).toEqual(['[download] stdout tail', '[download] stderr tail'])
    expect(writeRecord.mock.calls[0]![1]).toMatchObject({
      stdout: '',
      stderr: '',
      exit_code: 0,
    })
    expect(writeOutputChunk.mock.calls.filter((call) => call[1] === 'stderr').map((call) => call[3]).join('')).toBe('[download] stderr tail')
  })

  it('keeps a partial stdout final path separate from a complete stderr progress line', async () => {
    const onProgress = vi.fn()
    const onLog = vi.fn()
    const mediaPath = join(dir, 'output.mp4')
    const result = download({ tapeId: 't1', url: 'https://example.test/v', libraryDir: dir, outputId: 'output', onProgress, onLog, signal: new AbortController().signal })
    await vi.waitFor(() => expect(spawnStreaming).toHaveBeenCalledOnce())

    child.stdout.write(`tapebox-final-filepath:${dir}/`)
    child.stderr.write('tapebox-progress:75.0%|20|1\n')
    child.stdout.write('output.mp4')
    child.stderr.write('[download] stderr tail')
    child.emit('close', 0, null)

    await expect(result).resolves.toEqual({ mediaPath, infoJsonPath: join(dir, 'output.info.json') })
    expect(onProgress).toHaveBeenCalledExactlyOnceWith({ percent: 75, speedBps: 20, etaSec: 1 })
    expect(onLog).toHaveBeenCalledExactlyOnceWith('[download] stderr tail')
    expect(writeRecord.mock.calls[0]![1]).toMatchObject({
      stdout: '',
      stderr: '',
      exit_code: 0,
    })
    expect(writeOutputChunk.mock.calls.filter((call) => call[1] === 'stderr').map((call) => call[3]).join('')).toBe('[download] stderr tail')
  })
})
