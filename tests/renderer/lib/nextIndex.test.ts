import { describe, expect, it } from 'vitest'
import { nextIndex } from '@renderer/lib/nextIndex'

describe('nextIndex', () => {
  it('moves down and up by one within bounds', () => {
    expect(nextIndex(1, 5, 1)).toBe(2)
    expect(nextIndex(1, 5, -1)).toBe(0)
  })

  it('clamps at the ends — no wrap', () => {
    expect(nextIndex(4, 5, 1)).toBe(4)
    expect(nextIndex(0, 5, -1)).toBe(0)
  })

  it('enters the list from no selection (-1): Down → first, Up → last', () => {
    expect(nextIndex(-1, 5, 1)).toBe(0)
    expect(nextIndex(-1, 5, -1)).toBe(4)
  })

  it('returns -1 for an empty list', () => {
    expect(nextIndex(-1, 0, 1)).toBe(-1)
    expect(nextIndex(0, 0, -1)).toBe(-1)
  })

  it('handles a single-item list', () => {
    expect(nextIndex(0, 1, 1)).toBe(0)
    expect(nextIndex(0, 1, -1)).toBe(0)
  })
})
