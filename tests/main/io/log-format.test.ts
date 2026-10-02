import { describe, expect, it } from 'vitest'
import { isDebugEnabled, serializeLogLine } from '@main/io/log-format'

const TIME = '2026-06-10T03:15:42.123Z'

function parse(line: string): Record<string, unknown> {
  return JSON.parse(line) as Record<string, unknown>
}

describe('serializeLogLine', () => {
  it('emits one newline-terminated JSON object', () => {
    const line = serializeLogLine(TIME, 'info', 'startup', { version: '0.0.1' })
    expect(line.endsWith('\n')).toBe(true)
    expect(line.indexOf('\n')).toBe(line.length - 1) // exactly one line
    expect(() => JSON.parse(line)).not.toThrow()
  })

  it('carries the full envelope plus the extra fields', () => {
    const record = parse(serializeLogLine(TIME, 'warn', 'job start', { tapeId: 't1', url: 'u' }))
    expect(record).toMatchObject({
      time: TIME,
      level: 'warn',
      message: 'job start',
      tapeId: 't1',
      url: 'u',
    })
  })

  it('serializes with no extra fields', () => {
    const record = parse(serializeLogLine(TIME, 'info', 'session not found; starting empty', undefined))
    expect(record).toEqual({ time: TIME, level: 'info', message: 'session not found; starting empty' })
  })

  it('never lets a caller field overwrite the reserved envelope', () => {
    // A field named time/level/message (e.g. forwarded from an untrusted
    // renderer object) must not hijack the line's own envelope.
    const record = parse(
      serializeLogLine(TIME, 'info', 'real message', { message: 'EVIL', time: '1999', level: 'error', ok: true }),
    )
    expect(record).toMatchObject({ time: TIME, level: 'info', message: 'real message', ok: true })
  })

  it('marks a circular field instead of throwing, and still serializes the rest', () => {
    const circular: Record<string, unknown> = {}
    circular['self'] = circular
    let line!: string
    expect(() => {
      line = serializeLogLine(TIME, 'error', 'boom', { circular, tapeId: 't1' })
    }).not.toThrow()
    const record = parse(line)
    expect(record).toMatchObject({
      time: TIME,
      level: 'error',
      message: 'boom',
      circular: '[unserializable]',
      tapeId: 't1',
    })
  })

  it('salvages serializable fields when one field genuinely cannot serialize', () => {
    // A BigInt is not circular but JSON.stringify refuses it — only that field is
    // marked; the rest of the diagnostic payload survives.
    let line!: string
    expect(() => {
      line = serializeLogLine(TIME, 'error', 'boom', { big: 10n, tapeId: 't1' })
    }).not.toThrow()
    const record = parse(line)
    expect(record).toMatchObject({
      time: TIME,
      level: 'error',
      message: 'boom',
      big: '[unserializable]',
      tapeId: 't1',
    })
  })
})

describe('isDebugEnabled', () => {
  it('is on for an unpackaged (development) build', () => {
    expect(isDebugEnabled(false, {})).toBe(true)
  })

  it('is off for a packaged release by default', () => {
    expect(isDebugEnabled(true, {})).toBe(false)
  })

  it('is on for a packaged release when TAPEBOX_DEBUG=1', () => {
    expect(isDebugEnabled(true, { TAPEBOX_DEBUG: '1' })).toBe(true)
  })

  it('ignores other TAPEBOX_DEBUG values in a release', () => {
    expect(isDebugEnabled(true, { TAPEBOX_DEBUG: '0' })).toBe(false)
    expect(isDebugEnabled(true, { TAPEBOX_DEBUG: 'true' })).toBe(false)
  })
})
