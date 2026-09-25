import { describe, expect, it } from 'vitest'
import { visibleRowRange } from '@renderer/lib/windowedRows'

describe('visibleRowRange', () => {
  it('renders the viewport plus overscan, not the whole list', () => {
    expect(visibleRowRange(0, 320, 32, 5000, 8)).toEqual({ start: 0, end: 18 })
    expect(visibleRowRange(32 * 1000, 320, 32, 5000, 8)).toEqual({ start: 992, end: 1018 })
  })

  it('clamps to the list bounds', () => {
    expect(visibleRowRange(32 * 4990, 320, 32, 5000, 8)).toEqual({ start: 4982, end: 5000 })
    expect(visibleRowRange(0, 320, 32, 3, 8)).toEqual({ start: 0, end: 3 })
    expect(visibleRowRange(0, 320, 32, 0, 8)).toEqual({ start: 0, end: 0 })
  })

  it('assumes a first screenful before the list is measured', () => {
    expect(visibleRowRange(0, 0, 32, 5000, 8)).toEqual({ start: 0, end: 28 })
  })
})
