import { describe, expect, it } from 'vitest'
import { frontOrders } from '@shared/order'

describe('frontOrders', () => {
  it('numbers a block from 0 when the list is empty', () => {
    expect(frontOrders([], 3)).toEqual([0, 1, 2])
  })

  it('returns nothing for a non-positive count', () => {
    expect(frontOrders([5], 0)).toEqual([])
    expect(frontOrders([5], -2)).toEqual([])
  })

  it('places a single newcomer just above the current minimum', () => {
    expect(frontOrders([0, 1, 2], 1)).toEqual([-1])
    expect(frontOrders([-3, 4], 1)).toEqual([-4])
  })

  it('places a block above everything, ascending so the first element is topmost', () => {
    const orders = frontOrders([0, 1, 2], 3)
    expect(orders).toEqual([-3, -2, -1])
    // Every newcomer sorts above every existing member, and the block keeps order.
    expect(Math.max(...orders)).toBeLessThan(0)
    expect([...orders]).toEqual([...orders].sort((a, b) => a - b))
  })

  it('keys off the minimum, not the count or maximum, of existing orders', () => {
    expect(frontOrders([10, -5, 3], 2)).toEqual([-7, -6])
  })
})
