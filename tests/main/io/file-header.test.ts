import { describe, expect, it } from 'vitest'
import { checkFileHeader, FORMATS, parseStoreJson, withFileHeader } from '@main/io/file-header'

// The one reading and writing of a file's header (file-identity-conventions);
// each store's own test pins its branch for each outcome.

const TAPE = FORMATS.tape
const FORMAT = { owner: 'tapebox', kind: 'tape', version: 1 }
const WRITER = { name: 'tapebox', version: '1.0.0' }

describe('checkFileHeader', () => {
  it('reads its own owner, kind and version, handing back the content without the header', () => {
    expect(checkFileHeader({ format: FORMAT, writer: WRITER, a: 1 }, TAPE)).toEqual({ status: 'read', value: { a: 1 } })
  })

  it('ignores other keys inside format', () => {
    expect(checkFileHeader({ format: { ...FORMAT, later: true }, a: 1 }, TAPE)).toEqual({ status: 'read', value: { a: 1 } })
  })

  it('never reads the writer', () => {
    for (const writer of [undefined, null, 'text', 7, { name: 'other', version: 99 }, { caller: { name: 'x' } }]) {
      expect(checkFileHeader({ format: FORMAT, writer, a: 1 }, TAPE), JSON.stringify(writer)).toEqual({ status: 'read', value: { a: 1 } })
    }
  })

  it('reports a newer version with its number', () => {
    expect(checkFileHeader({ format: { ...FORMAT, version: 3 } }, TAPE)).toEqual({ status: 'newer', version: 3 })
  })

  it('refuses a missing or malformed header as unreadable', () => {
    for (const value of [
      { a: 1 }, { formatVersion: 1 }, { format: 1 }, { format: 'tapebox.tape' }, { format: null }, { format: [] },
      { format: { owner: 'tapebox', kind: 'tape' } }, { format: { ...FORMAT, version: '1' } }, { format: { ...FORMAT, version: 1.5 } },
      { format: { ...FORMAT, version: 0 } }, { format: { ...FORMAT, version: -1 } }, { format: { ...FORMAT, owner: 7 } },
      { format: { ...FORMAT, kind: null } },
    ]) {
      expect(checkFileHeader(value, TAPE).status, JSON.stringify(value)).toBe('unreadable')
    }
  })

  it('refuses another owner\'s or another kind\'s file whatever its version', () => {
    for (const format of [{ ...FORMAT, owner: 'gptimg' }, { ...FORMAT, owner: 'TapeBox' }, { ...FORMAT, kind: 'shelf' }, { ...FORMAT, kind: 'shelf', version: 9 }]) {
      expect(checkFileHeader({ format }, TAPE).status, JSON.stringify(format)).toBe('unreadable')
    }
  })
})

describe('parseStoreJson', () => {
  it('refuses malformed JSON and non-object roots', () => {
    for (const text of ['{ nope', 'null', '[]', '"text"']) {
      expect(parseStoreJson(text, TAPE).status, text).toBe('unreadable')
    }
  })

  it('checks the header of what it parses', () => {
    expect(parseStoreJson(JSON.stringify({ format: FORMAT, writer: WRITER, a: 1 }), TAPE)).toEqual({ status: 'read', value: { a: 1 } })
  })
})

describe('FORMATS', () => {
  it('names every kind in lowercase kebab-case, each once, at version 1', () => {
    const kinds = Object.values(FORMATS).map((format) => format.kind)
    for (const kind of kinds) expect(kind).toMatch(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
    expect(new Set(kinds).size).toBe(kinds.length)
    expect(Object.values(FORMATS).every((format) => format.version === 1)).toBe(true)
  })
})

describe('withFileHeader', () => {
  it('puts format and writer first, replacing any the value held', () => {
    expect(Object.entries(withFileHeader({ a: 1, format: 9, writer: 'old' }, TAPE, WRITER)))
      .toEqual([['format', FORMAT], ['writer', WRITER], ['a', 1]])
  })

  it('writes only the writer\'s name and version', () => {
    expect(withFileHeader({}, TAPE, { ...WRITER, extra: true } as typeof WRITER).writer).toEqual(WRITER)
  })
})
