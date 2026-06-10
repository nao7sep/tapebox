import { describe, expect, it } from 'vitest'
import { isDebugEnabled, serializeLogLine } from '@main/io/log-format'
import { DENIED_KEYS } from '@main/io/logger'

const DENIED: ReadonlySet<string> = new Set(['apikey', 'authorization', 'token', 'password', 'secret'])
const TIME = '2026-06-10T03:15:42.123Z'

function parse(line: string): Record<string, unknown> {
  return JSON.parse(line) as Record<string, unknown>
}

describe('serializeLogLine', () => {
  it('emits one newline-terminated JSON object', () => {
    const line = serializeLogLine(TIME, 'info', 'startup', { version: '0.0.1' }, DENIED)
    expect(line.endsWith('\n')).toBe(true)
    expect(line.indexOf('\n')).toBe(line.length - 1) // exactly one line
    expect(() => JSON.parse(line)).not.toThrow()
  })

  it('carries the full envelope plus the extra fields', () => {
    const record = parse(serializeLogLine(TIME, 'warn', 'job start', { tapeId: 't1', url: 'u' }, DENIED))
    expect(record).toMatchObject({
      time: TIME,
      level: 'warn',
      message: 'job start',
      tapeId: 't1',
      url: 'u',
    })
  })

  it('redacts denied fields before serialization', () => {
    const record = parse(serializeLogLine(TIME, 'info', 'ai request', { model: 'x', apiKey: 'sk-secret' }, DENIED))
    expect(record['model']).toBe('x')
    expect(record['apiKey']).toBe('[redacted]')
  })

  it('serializes with no extra fields', () => {
    const record = parse(serializeLogLine(TIME, 'info', 'session not found; starting empty', undefined, DENIED))
    expect(record).toEqual({ time: TIME, level: 'info', message: 'session not found; starting empty' })
  })

  it('never lets a caller field overwrite the reserved envelope', () => {
    // A field named time/level/message (e.g. forwarded from an untrusted
    // renderer object) must not hijack the line's own envelope.
    const record = parse(
      serializeLogLine(TIME, 'info', 'real message', { message: 'EVIL', time: '1999', level: 'error', ok: true }, DENIED),
    )
    expect(record).toMatchObject({ time: TIME, level: 'info', message: 'real message', ok: true })
  })

  it('breaks circular references instead of throwing, and still serializes', () => {
    const circular: Record<string, unknown> = {}
    circular['self'] = circular
    let line!: string
    expect(() => {
      line = serializeLogLine(TIME, 'error', 'boom', { circular }, DENIED)
    }).not.toThrow()
    const record = parse(line)
    expect(record).toMatchObject({
      time: TIME,
      level: 'error',
      message: 'boom',
      circular: { self: '[circular]' },
    })
    expect(record['serializeError']).toBeUndefined()
  })

  it('salvages serializable fields when one field genuinely cannot serialize', () => {
    // A BigInt is not circular but JSON.stringify refuses it — only that field is
    // marked; the rest of the diagnostic payload survives.
    let line!: string
    expect(() => {
      line = serializeLogLine(TIME, 'error', 'boom', { big: 10n, tapeId: 't1' }, DENIED)
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

describe('DENIED_KEYS (the logger\'s live redaction config)', () => {
  it('redacts each seeded secret-bearing field name through the real set', () => {
    for (const key of ['apiKey', 'authorization', 'token', 'password', 'secret']) {
      const record = parse(serializeLogLine(TIME, 'info', 'x', { [key]: 'sensitive' }, DENIED_KEYS))
      expect(record[key]).toBe('[redacted]')
    }
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
