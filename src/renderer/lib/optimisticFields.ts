/**
 * Restore only fields submitted by one optimistic operation, while it still owns
 * their values. Metadata and later changes belong to their current writers.
 */
export function rollbackOptimisticFields<T extends object, K extends keyof T>(
  current: T,
  before: T,
  optimisticPatch: Partial<Pick<T, K>>,
): T {
  let restored = current
  for (const field of Object.keys(optimisticPatch) as K[]) {
    if (current[field] !== optimisticPatch[field] || current[field] === before[field]) continue
    if (restored === current) restored = { ...current }
    restored[field] = before[field]
  }
  return restored
}
