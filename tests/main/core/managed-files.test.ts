import { describe, expect, it } from 'vitest'
import { nameInStem } from '@main/core/managed-files'

describe('managed filename stems', () => {
  it('covers provider extensions and nested fragment stems without taking unrelated files', () => {
    expect(nameInStem('tapeid.info.json', 'TapeId')).toBe(true)
    expect(nameInStem('TapeId.mp4.part', 'TapeId')).toBe(true)
    expect(nameInStem('TapeId.poster-raw.webp', 'TapeId')).toBe(true)
    expect(nameInStem('TapeIdish.jpg', 'TapeId')).toBe(false)
  })
})
