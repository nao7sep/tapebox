import { describe, expect, it } from 'vitest'
import { parseStoreJson, withFormatVersion } from '@main/io/format-version'

// The one reading of a JSON store's marker (store-recovery-conventions); each
// store's own test pins its branch for each outcome.

describe('parseStoreJson', () => {
  it('reads 1 as this build\'s own', () => {
    expect(parseStoreJson('{"formatVersion":1,"a":1}', 1)).toEqual({ status: 'read', value: { formatVersion: 1, a: 1 }, version: 1 })
  })

  it('passes missing and unrecognized markers to the current shape reader', () => {
    for (const value of [{ a: 1 }, { formatVersion: 0 }, { formatVersion: 1.5 }, { formatVersion: '2' }, { formatVersion: null }]) {
      expect(parseStoreJson(JSON.stringify(value), 1)).toEqual({ status: 'read', value, version: 1 })
    }
  })

  it('reports a newer marker with its version', () => {
    expect(parseStoreJson('{"formatVersion":3}', 1)).toEqual({ status: 'newer', version: 3 })
  })

  it('refuses malformed JSON and non-object roots', () => {
    for (const text of ['{ nope', 'null', '[]', '"text"']) {
      expect(parseStoreJson(text, 1).status, text).toBe('unreadable')
    }
  })
})

describe('withFormatVersion', () => {
  it('puts the marker first, replacing any the value held', () => {
    expect(Object.entries(withFormatVersion({ a: 1, formatVersion: 9 }, 1))).toEqual([['formatVersion', 1], ['a', 1]])
  })
})
