import { describe, expect, it, vi } from 'vitest'

import { moveArrayItem, rollbackOptimisticOrder, settleOptimisticOrder } from '@renderer/lib/optimisticOrder'
import { rollbackOptimisticFields } from '@renderer/lib/optimisticFields'

describe('moveArrayItem', () => {
  it('moves one stable item without mutating the source collection', () => {
    const source = ['a', 'b', 'c']

    expect(moveArrayItem(source, 0, 2)).toEqual(['b', 'c', 'a'])
    expect(source).toEqual(['a', 'b', 'c'])
  })
})

describe('optimistic field ownership', () => {
  it('restores submitted fields independently without mutating current data', () => {
    const before = { name: 'Before', boxId: 'source', order: 10 }
    const current = { name: 'Live rename', boxId: 'target', order: 77 }

    const restored = rollbackOptimisticFields(current, before, { boxId: 'target', order: 0 })

    expect(restored).toEqual({ name: 'Live rename', boxId: 'source', order: 77 })
    expect(current).toEqual({ name: 'Live rename', boxId: 'target', order: 77 })
  })

  it('keeps superseded and added objects without resurrecting removed members', () => {
    const before = [{ id: 'a', name: 'Before', order: 10 }, { id: 'removed', name: 'Removed', order: 20 }]
    const optimistic = [{ ...before[0], order: 0 }, { ...before[1], order: 1 }]
    const added = { id: 'added', name: 'Added', order: -1 }
    const live = { id: 'a', name: 'Live rename', order: 77 }
    const current = [live, added]

    const restored = rollbackOptimisticOrder(current, before, optimistic)

    expect(restored).toEqual(current)
    expect(restored[0]).toBe(live)
    expect(restored[1]).toBe(added)
  })
})

describe('settleOptimisticOrder', () => {
  it('rolls back and reports when the failed projection is still current', async () => {
    const rollback = vi.fn()
    const succeed = vi.fn()
    const report = vi.fn()
    settleOptimisticOrder(Promise.reject(new Error('disk full')), () => true, rollback, succeed, report)

    await Promise.resolve()
    expect(rollback).toHaveBeenCalledOnce()
    expect(succeed).not.toHaveBeenCalled()
    expect(report).toHaveBeenCalledWith(expect.objectContaining({ message: 'disk full' }))
  })

  it('preserves a newer projection without presenting the superseded failure', async () => {
    const rollback = vi.fn()
    const succeed = vi.fn()
    const report = vi.fn()
    settleOptimisticOrder(Promise.reject(new Error('older failed')), () => false, rollback, succeed, report)

    await Promise.resolve()
    expect(rollback).not.toHaveBeenCalled()
    expect(succeed).not.toHaveBeenCalled()
    expect(report).not.toHaveBeenCalled()
  })

  it('clears the current list failure only after persistence succeeds', async () => {
    const rollback = vi.fn()
    const succeed = vi.fn()
    const report = vi.fn()
    settleOptimisticOrder(Promise.resolve(), () => true, rollback, succeed, report)

    await Promise.resolve()
    expect(succeed).toHaveBeenCalledOnce()
    expect(rollback).not.toHaveBeenCalled()
    expect(report).not.toHaveBeenCalled()
  })
})
