import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { describe, expect, it, vi } from 'vitest'

const child = vi.hoisted(() => ({ spawn: vi.fn() }))
vi.mock('node:child_process', () => ({ spawn: child.spawn }))
import { execCapture, makeLineBuffer } from '@main/io/spawn'

describe('subprocess UTF-8 text', () => {
  it('preserves a path marker and scan JSON at every byte boundary', () => {
    const lines = ['__final_filepath__:/library/日本語-🎞️.mp4', JSON.stringify({ title: 'é動画🎬', url: 'https://example.com/日本語' })]
    const bytes = Buffer.from(lines.join('\r\n'))
    for (let split = 1; split < bytes.length; split++) {
      const found: string[] = []
      const buffer = makeLineBuffer((line) => found.push(line))
      buffer.feed(bytes.subarray(0, split))
      buffer.feed(bytes.subarray(split))
      buffer.flush()
      expect(found, `split ${split}`).toEqual(lines)
    }
  })

  it('flushes an incomplete sequence once, without sharing state between pipes', () => {
    const out: string[] = []
    const err: string[] = []
    const stdout = makeLineBuffer((line) => out.push(line))
    const stderr = makeLineBuffer((line) => err.push(line))
    stdout.feed(Buffer.from([0xe6, 0x97]))
    stderr.feed('stderr\n')
    stdout.flush()
    stdout.flush()
    stderr.flush()
    expect(out).toEqual(['�'])
    expect(err).toEqual(['stderr'])
  })

  it('decodes captured stdout and stderr independently across single-byte chunks', async () => {
    const process = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough() })
    child.spawn.mockReturnValueOnce(process)
    const result = execCapture('fixture', [])
    const output = '日本語🎬'
    const error = 'é失敗'
    for (const byte of Buffer.from(output)) process.stdout.write(Buffer.from([byte]))
    for (const byte of Buffer.from(error)) process.stderr.write(Buffer.from([byte]))
    process.stdout.end()
    process.stderr.end()
    await Promise.all([new Promise<void>((resolve) => process.stdout.on('end', resolve)), new Promise<void>((resolve) => process.stderr.on('end', resolve))])
    process.emit('close', 0)
    await expect(result).resolves.toEqual({ stdout: output, stderr: error, exitCode: 0 })
  })
})
