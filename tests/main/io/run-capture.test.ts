import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { describe, expect, it, vi } from 'vitest'
import type { OutputChild } from '@main/io/spawn'

const { writeOutputChunk } = vi.hoisted(() => ({ writeOutputChunk: vi.fn() }))
vi.mock('@main/io/records', () => ({ writeOutputChunk }))
const { createRunCapture, OUTPUT_CHUNK_UNITS } = await import('@main/io/run-capture')

function child() {
  return Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough() }) as OutputChild & EventEmitter
}
const text = (stream: string) => writeOutputChunk.mock.calls.filter((call) => call[1] === stream).map((call) => call[3]).join('')

describe('streaming run capture', () => {
  it('retains long evidence as bounded messages with only a safe stderr tail in memory', () => {
    writeOutputChunk.mockClear()
    const proc = child()
    const capture = createRunCapture(proc)
    const block = 'a'.repeat(32_766) + '\u{1F600}tail\n'
    for (let i = 0; i < 20; i++) { proc.stdout.emit('data', Buffer.from(block)); proc.stderr.emit('data', Buffer.from(block)) }
    proc.emit('close', 1, null)
    capture.finish()
    expect(capture.stdout()).toBe('')
    expect(capture.stderr().length).toBeLessThanOrEqual(32_768)
    expect(text('stdout')).toBe(block.repeat(20))
    expect(text('stderr')).toBe(block.repeat(20))
    for (const stream of ['stdout', 'stderr']) {
      const calls = writeOutputChunk.mock.calls.filter((call) => call[1] === stream)
      expect(calls.map((call) => call[2])).toEqual(calls.map((_, index) => index))
      for (const call of calls) {
        expect(call[0]).toBe(capture.outputKey)
        expect(call[3].length).toBeLessThanOrEqual(OUTPUT_CHUNK_UNITS)
        expect(call[3]).not.toMatch(/^[\uDC00-\uDFFF]|[\uD800-\uDBFF]$/)
      }
    }
  })

  it('decodes split UTF8, masks split credentials and discards progress before writing', () => {
    writeOutputChunk.mockClear()
    const proc = child()
    const capture = createRunCapture(proc, { credentials: ['secret123'], dropProgress: true })
    const bytes = Buffer.from('tapebox-progress:secret123\nvisible \u{1F600} secret123\ntapebox-progress:unfinished')
    for (const byte of bytes) proc.stdout.emit('data', Buffer.from([byte]))
    proc.stderr.emit('data', Buffer.from('secr'))
    proc.stderr.emit('data', Buffer.from('et123'))
    proc.emit('close', 0, null)
    expect(text('stdout')).toBe('visible \u{1F600} [REDACTED]\n')
    expect(text('stderr')).toBe('[REDACTED]')
    expect(capture.stderr()).toBe('[REDACTED]')
    expect(capture.stdout()).toBe('')
  })

  it('retains raw stdout only for the caller that parses probe JSON', () => {
    writeOutputChunk.mockClear()
    const proc = child()
    const capture = createRunCapture(proc, { rawStdout: true })
    const raw = '{"cookies":"private-cookie","title":"\u{1F600}"}'
    for (const byte of Buffer.from(raw)) proc.stdout.emit('data', Buffer.from([byte]))
    proc.emit('close', 0, null)
    expect(capture.stdout()).toBe(raw)
    expect(text('stdout')).toBe('{"cookies":"[REDACTED]","title":"\u{1F600}"}')
  })
})
