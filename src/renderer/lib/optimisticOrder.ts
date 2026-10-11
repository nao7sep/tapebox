import type { Tape } from '@shared/domain'
import { rollbackOptimisticFields } from '@renderer/lib/optimisticFields'

/** Return one collection item moved between valid indices. */
export function moveArrayItem<T>(items: readonly T[], from: number, to: number): T[] {
  const next = [...items]
  const [item] = next.splice(from, 1)
  next.splice(to, 0, item)
  return next
}

type OrderedItem = { id: string; order: number }

/** A tape's order belongs to its current Inbox, Unboxed, or box tape list. */
export function isInSameTapeList(
  current: Pick<Tape, 'archivedAtUtc' | 'boxId'>,
  submitted: Pick<Tape, 'archivedAtUtc' | 'boxId'>,
): boolean {
  const archived = !!submitted.archivedAtUtc
  return !!current.archivedAtUtc === archived && (!archived || current.boxId === submitted.boxId)
}

/** Roll back order on current members, preserving additions, removals and metadata. */
export function rollbackOptimisticOrder<T extends OrderedItem>(
  current: readonly T[],
  before: readonly T[],
  optimistic: readonly T[],
  eligible?: (current: T, submitted: T) => boolean,
): T[] {
  const beforeById = new Map(before.map((item) => [item.id, item]))
  const optimisticById = new Map(optimistic.map((item) => [item.id, item]))
  return current.map((item) => {
    const previous = beforeById.get(item.id)
    const submitted = optimisticById.get(item.id)
    if (!previous || !submitted || (eligible && !eligible(item, submitted))) return item
    return rollbackOptimisticFields(item, previous, { order: submitted.order })
  })
}

/**
 * Settles one optimistic reorder while its list attempt is still current. The
 * caller restores only still-owned fields, so an unrelated whole-row refresh
 * cannot hide the failure or strand other members at the rejected order.
 */
export function settleOptimisticOrder(
  persistence: Promise<unknown>,
  isStillCurrent: () => boolean,
  rollback: () => void,
  succeed: () => void,
  fail: (error: unknown) => void,
): void {
  void persistence.then(
    () => {
      if (isStillCurrent()) succeed()
    },
    (error) => {
      // A later reorder of this list owns its outcome, including across view
      // remounts. Main has already logged a superseded write failure.
      if (!isStillCurrent()) return
      rollback()
      fail(error)
    },
  )
}
