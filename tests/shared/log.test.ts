import { describe, expect, it } from 'vitest'
import { LOG_LEVELS, parseLogMessage } from '@shared/log'

describe('parseLogMessage', () => {
  it('accepts a well-formed message with fields', () => {
    expect(parseLogMessage({ level: 'info', message: 'x', fields: { a: 1 } })).toEqual({
      level: 'info',
      message: 'x',
      fields: { a: 1 },
    })
  })

  it('accepts a message with no fields', () => {
    expect(parseLogMessage({ level: 'warn', message: 'y' })).toEqual({ level: 'warn', message: 'y', fields: undefined })
  })

  it('accepts every level in LOG_LEVELS', () => {
    for (const level of LOG_LEVELS) {
      expect(parseLogMessage({ level, message: 'm' })?.level).toBe(level)
    }
  })

  it('rejects an unknown level', () => {
    expect(parseLogMessage({ level: 'trace', message: 'm' })).toBeNull()
  })

  it('rejects a non-string message', () => {
    expect(parseLogMessage({ level: 'info', message: 123 })).toBeNull()
  })

  it('rejects an array as fields (would spread to index-keyed junk)', () => {
    expect(parseLogMessage({ level: 'info', message: 'm', fields: [1, 2] })).toBeNull()
  })

  it('rejects a null fields value', () => {
    expect(parseLogMessage({ level: 'info', message: 'm', fields: null })).toBeNull()
  })

  it('rejects non-object payloads', () => {
    expect(parseLogMessage(null)).toBeNull()
    expect(parseLogMessage('nope')).toBeNull()
    expect(parseLogMessage(undefined)).toBeNull()
  })
})
