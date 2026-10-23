import { describe, expect, it } from 'vitest'
import { CatalogOwnership } from '@main/core/catalog-ownership'
import type { Tape } from '@shared/domain'

const tape = (id: string, filename: string | null = null, sourceUrl = `https://example.test/${id}`): Tape => ({
  id, filename, sidecarFilename: null, thumbnailFilename: null, sourceUrl, extractor: 'test', sourceId: id,
} as Tape)

describe('live catalog ownership', () => {
  it('covers portable aliases, exact filenames and nested ID namespaces', () => {
    const first = tape('Tape', 'Cafe\u0301.mp4')
    const second = tape('Tape.child', 'Other.info.json')
    const index = new CatalogOwnership([first, second])
    expect(index.filenameOwner('CAFÉ.MP4')).toBe('Tape')
    expect(index.filenameOwner('tape.child.part', 'Tape')).toBe('Tape.child')
    expect(index.filenameOwner('tape.part', 'Tape')).toBeUndefined()
    expect(index.filenameOwner('tapeish.part')).toBeUndefined()
    expect(index.stemOwner('TAPE', 'Tape')).toBe('Tape.child')
    expect(index.stemOwner('Other')).toBe('Tape.child')
    expect(index.stemOwner('Other.info')).toBe('Tape.child')
    expect(index.stemOwner('Other.info.json')).toBeUndefined()
    index.replace(second)
    expect(index.stemOwner('Tape', 'Tape')).toBeUndefined()
    expect(index.stemOwner('Other')).toBeUndefined()
  })

  it('keeps other owners when a shared prefix or source is replaced or removed', () => {
    const first = tape('First', 'shared.a.mp4', 'https://example.test/shared')
    const second = tape('Second', 'shared.b.mp4', first.sourceUrl)
    const index = new CatalogOwnership([first, second])
    expect(index.sourceOwner({ url: first.sourceUrl }, first.id)).toBe(second.id)
    expect(index.stemOwner('shared', first.id)).toBe(second.id)
    index.replace(first, { ...first, filename: 'new.mp4', sourceUrl: 'https://example.test/new', sourceId: 'new' })
    expect(index.sourceOwner({ url: first.sourceUrl })).toBe(second.id)
    expect(index.stemOwner('shared')).toBe(second.id)
    expect(index.filenameOwner('shared.a.mp4')).toBeUndefined()
    index.replace(second)
    expect(index.stemOwner('shared')).toBeUndefined()
    expect(index.sourceOwner({ url: first.sourceUrl })).toBeUndefined()
    expect(index.sourceOwner({ url: 'https://example.test/new' })).toBe(first.id)
  })

  it('does not revisit unrelated rows when looking up or changing one tape', () => {
    let reads = 0
    const tapes = Array.from({ length: 1000 }, (_, id) => {
      const row = tape(`Tape${id}`, `File${id}.mp4`)
      return new Proxy(row, { get(target, key, receiver) { reads++; return Reflect.get(target, key, receiver) } })
    })
    const index = new CatalogOwnership(tapes)
    reads = 0
    for (let id = 0; id < 1000; id++) expect(index.filenameOwner(`FILE${id}.MP4`)).toBe(`Tape${id}`)
    expect(reads).toBe(0)
    index.replace(tapes[0], tape('Tape0', 'Changed.mp4'))
    expect(reads).toBeLessThan(50)
    expect(index.filenameOwner('Changed.mp4')).toBe('Tape0')
    expect(index.filenameOwner('File0.mp4')).toBeUndefined()
  })
})
