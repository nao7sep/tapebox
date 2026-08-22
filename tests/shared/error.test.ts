import { describe, expect, it } from 'vitest'
import { CIRCULAR_CAUSE, describeError, errorMessage, type LoggableError } from '@shared/error'

describe('describeError', () => {
  it('captures type, message, and stack for a plain Error', () => {
    const err = new TypeError('boom')
    const out = describeError(err)
    expect(out).toMatchObject({ name: 'TypeError', message: 'boom' })
    expect(typeof out['stack']).toBe('string')
  })

  it('flattens a non-Error throwable to a message', () => {
    expect(describeError('just a string')).toEqual({ message: 'just a string' })
    expect(describeError(42)).toEqual({ message: '42' })
    expect(describeError(null)).toEqual({ message: 'null' })
  })

  it('walks the wrapped cause chain', () => {
    const root = new Error('root')
    const wrapped = new Error('wrapped', { cause: root })
    const out = describeError(wrapped)
    expect(out['message']).toBe('wrapped')
    expect(out['cause']).toMatchObject({ name: 'Error', message: 'root' })
  })

  it('preserves nested AggregateError branches for structured logs', () => {
    const recovery = new Error('/tmp/tapebox-recovery-hold.tmp')
    const out = describeError(new AggregateError([new Error('copy failed'), recovery], 'rollback failed'))
    expect(out['errors']).toEqual(expect.arrayContaining([
      expect.objectContaining({ message: 'copy failed' }),
      expect.objectContaining({ message: '/tmp/tapebox-recovery-hold.tmp' }),
    ]))
  })

  it('caps a self-referential cause instead of overflowing the stack', () => {
    const err = new Error('self') as Error & { cause?: unknown }
    err.cause = err
    let out!: Record<string, unknown>
    expect(() => {
      out = describeError(err)
    }).not.toThrow()
    expect(out['cause']).toBe(CIRCULAR_CAUSE)
  })

  it('caps a mutual cause cycle (a → b → a)', () => {
    const a = new Error('a') as Error & { cause?: unknown }
    const b = new Error('b') as Error & { cause?: unknown }
    a.cause = b
    b.cause = a
    let out!: Record<string, unknown>
    expect(() => {
      out = describeError(a)
    }).not.toThrow()
    // a → b (real) → a (collapsed to the marker)
    const bInfo = out['cause'] as Record<string, unknown>
    expect(bInfo['message']).toBe('b')
    expect(bInfo['cause']).toBe(CIRCULAR_CAUSE)
  })

  it('merges discrete fields from a LoggableError', () => {
    class SubErr extends Error implements LoggableError {
      constructor() {
        super('cmd exited 1')
        this.name = 'SubErr'
      }
      toLogFields() {
        return { command: 'yt-dlp', exitCode: 1, stderr: 'oops' }
      }
    }
    const out = describeError(new SubErr())
    expect(out).toMatchObject({ name: 'SubErr', message: 'cmd exited 1', command: 'yt-dlp', exitCode: 1, stderr: 'oops' })
  })

  it('stays total when a LoggableError.toLogFields throws', () => {
    class BadErr extends Error implements LoggableError {
      constructor() {
        super('the underlying failure')
        this.name = 'BadErr'
      }
      toLogFields(): Record<string, unknown> {
        throw new Error('field builder blew up')
      }
    }
    let out!: Record<string, unknown>
    expect(() => {
      out = describeError(new BadErr())
    }).not.toThrow()
    // Base fields survive even though the extra fields couldn't be built.
    expect(out).toMatchObject({ name: 'BadErr', message: 'the underlying failure' })
    expect(typeof out['stack']).toBe('string')
  })
})

describe('errorMessage', () => {
  it('returns the message for an Error', () => {
    expect(errorMessage(new Error('hi'))).toBe('hi')
  })
  it('stringifies a non-Error', () => {
    expect(errorMessage({ toString: () => 'obj' })).toBe('obj')
    expect(errorMessage(7)).toBe('7')
  })
  it('flattens nested aggregate and cause messages for user-visible transport', () => {
    const recovery = '/tmp/tapebox-recovery-hold.tmp'
    const nested = new AggregateError([new Error(`Recovery claim: ${recovery}`)], 'cleanup failed')
    const wrapped = new Error('rename failed', { cause: nested })
    expect(errorMessage(wrapped)).toContain('rename failed')
    expect(errorMessage(wrapped)).toContain('cleanup failed')
    expect(errorMessage(wrapped)).toContain(recovery)
  })
})
