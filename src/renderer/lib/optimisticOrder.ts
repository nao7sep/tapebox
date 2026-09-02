/** Return one collection item moved between valid indices. */
export function moveArrayItem<T>(items: readonly T[], from: number, to: number): T[] {
  const next = [...items]
  const [item] = next.splice(from, 1)
  next.splice(to, 0, item)
  return next
}

/**
 * Settles one optimistic reorder without letting an older failed write overwrite
 * a newer rendered order. The caller owns the concrete store snapshots.
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
      // A superseded attempt no longer owns the rendered consequence: its newer
      // order stays visible, and the main IPC boundary has already logged the old
      // failure. Only the still-current projection reverts and reports locally.
      if (!isStillCurrent()) return
      rollback()
      fail(error)
    },
  )
}
