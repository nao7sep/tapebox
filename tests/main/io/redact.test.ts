import { describe, expect, it } from 'vitest'
import { REDACTED, redact } from '@main/io/redact'

const DENIED: ReadonlySet<string> = new Set([
  'apikey',
  'authorization',
  'token',
  'password',
  'secret',
])

describe('redact', () => {
  it('replaces a matched field value with the marker', () => {
    expect(redact({ token: 'abc123' }, DENIED)).toEqual({ token: REDACTED })
  })

  it('matches field names case-insensitively', () => {
    expect(redact({ Authorization: 'Bearer x', ApiKey: 'k' }, DENIED)).toEqual({
      Authorization: REDACTED,
      ApiKey: REDACTED,
    })
  })

  it('matches names exactly, never as a substring', () => {
    // `token` must not match `tokenCount` or `broken`.
    const input = { tokenCount: 7, broken: true, token: 'x' }
    expect(redact(input, DENIED)).toEqual({ tokenCount: 7, broken: true, token: REDACTED })
  })

  it('recurses through nested objects and arrays', () => {
    const input = {
      user: 'amy',
      creds: { password: 'p', nested: [{ secret: 's' }, { keep: 1 }] },
    }
    expect(redact(input, DENIED)).toEqual({
      user: 'amy',
      creds: { password: REDACTED, nested: [{ secret: REDACTED }, { keep: 1 }] },
    })
  })

  it('never scans string contents or edits a message', () => {
    // A secret-looking value living in `message` is left byte-identical: the
    // redactor matches names, never string bodies.
    const input = { message: 'token=abc password=hunter2', level: 'info' }
    expect(redact(input, DENIED)).toEqual(input)
  })

  it('passes primitives, Date, and other non-plain objects through untouched', () => {
    const when = new Date('2026-06-10T03:15:42.123Z')
    const input = { count: 3, ok: true, when, missing: null }
    const out = redact(input, DENIED)
    expect(out).toEqual(input)
    // Same Date instance, not coerced to {} — type-preserving.
    expect(out.when).toBe(when)
  })

  it('is pure — it does not mutate its input', () => {
    const input = { token: 'abc', nested: { secret: 's' } }
    const snapshot = structuredClone(input)
    redact(input, DENIED)
    expect(input).toEqual(snapshot)
  })

  it('does not throw on awkward shapes', () => {
    expect(() => redact({ a: [1, [2, { token: 't' }]], b: undefined }, DENIED)).not.toThrow()
    expect(redact([{ token: 't' }], DENIED)).toEqual([{ token: REDACTED }])
  })

  it('breaks circular references with a marker rather than overflowing the stack', () => {
    const obj: Record<string, unknown> = { token: 'x' }
    obj['self'] = obj
    let out!: Record<string, unknown>
    expect(() => {
      out = redact(obj, DENIED)
    }).not.toThrow()
    expect(out).toEqual({ token: REDACTED, self: '[circular]' })
  })

  it('serializes a diamond (shared, non-circular) reference at each site', () => {
    const shared = { keep: 1 }
    const out = redact({ a: shared, b: shared }, DENIED)
    expect(out).toEqual({ a: { keep: 1 }, b: { keep: 1 } })
  })
})
