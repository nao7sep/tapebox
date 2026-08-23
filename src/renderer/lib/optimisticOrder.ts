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
