import { describe, expect, it, vi } from 'vitest'

import { moveArrayItem, settleOptimisticOrder } from '@renderer/lib/optimisticOrder'

describe('moveArrayItem', () => {
  it('moves one stable item without mutating the source collection', () => {
    const source = ['a', 'b', 'c']

    expect(moveArrayItem(source, 0, 2)).toEqual(['b', 'c', 'a'])
    expect(source).toEqual(['a', 'b', 'c'])
  })
})

describe('settleOptimisticOrder', () => {
  it('rolls back and reports when the failed projection is still current', async () => {
    const rollback = vi.fn()
    const report = vi.fn()
    settleOptimisticOrder(Promise.reject(new Error('disk full')), () => true, rollback, report)

    await Promise.resolve()
    expect(rollback).toHaveBeenCalledOnce()
    expect(report).toHaveBeenCalledWith(expect.objectContaining({ message: 'disk full' }))
  })

  it('preserves a newer projection while still reporting the older failure', async () => {
    const rollback = vi.fn()
    const report = vi.fn()
    settleOptimisticOrder(Promise.reject(new Error('older failed')), () => false, rollback, report)

    await Promise.resolve()
    expect(rollback).not.toHaveBeenCalled()
    expect(report).toHaveBeenCalledOnce()
  })
})
