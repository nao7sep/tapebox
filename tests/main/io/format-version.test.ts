import { describe, expect, it } from 'vitest'
import { parseStoreJson, withFormatVersion } from '@main/io/format-version'

// The one reading of a JSON store's marker (store-recovery-conventions); each
// store's own test pins its branch for each outcome.

describe('parseStoreJson', () => {
  it('reads 1 as this build\'s own', () => {
    expect(parseStoreJson('{"formatVersion":1,"a":1}', 1)).toEqual({ status: 'read', value: { formatVersion: 1, a: 1 }, version: 1 })
  })

  it('reads a missing marker as v0.1.0\'s format only for a store that existed then', () => {
    expect(parseStoreJson('{"a":1}', 1, true)).toEqual({ status: 'read', value: { a: 1 }, version: 0 })
    expect(parseStoreJson('{"a":1}', 1).status).toBe('unreadable')
    expect(parseStoreJson('{"formatVersion":0}', 1, true).status, 'an explicit 0 is not v0.1.0').toBe('unreadable')
  })

  it('reports a newer marker with its version', () => {
    expect(parseStoreJson('{"formatVersion":3}', 1)).toEqual({ status: 'newer', version: 3 })
  })

  it('reads text that is not a JSON object, a missing marker, or one that is not a positive integer, as unreadable', () => {
    for (const text of ['{ nope', '{"a":1}', 'null', '[]', '"text"', '{"formatVersion":0}', '{"formatVersion":1.5}',
      '{"formatVersion":"2"}', '{"formatVersion":null}']) {
      expect(parseStoreJson(text, 1).status, text).toBe('unreadable')
    }
  })
})

describe('withFormatVersion', () => {
  it('puts the marker first, replacing any the value held', () => {
    expect(Object.entries(withFormatVersion({ a: 1, formatVersion: 9 }, 1))).toEqual([['formatVersion', 1], ['a', 1]])
  })
})
