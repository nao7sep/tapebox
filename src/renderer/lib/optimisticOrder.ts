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
  report: (error: unknown) => void,
): void {
  void persistence.catch((error) => {
    if (isStillCurrent()) rollback()
    report(error)
  })
}
