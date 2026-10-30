/**
 * The Inbox has no chosen order: newest added first, and tapes added together
 * keep their pasted order, first URL topmost. Ties beyond that fall to the id so
 * every reader shows the same sequence.
 */
export function compareInbox(
  a: { addedAtUtc: string; addedIndex: number; id: string },
  b: { addedAtUtc: string; addedIndex: number; id: string },
): number {
  return b.addedAtUtc.localeCompare(a.addedAtUtc) || a.addedIndex - b.addedIndex || a.id.localeCompare(b.id)
}

/**
 * Manual ordering primitive shared by the Shelf's lists — each box and Loose
 * tapes. Each shelved tape carries an `order` (lower = nearer the top); a list
 * is rendered sorted ascending by it. Newcomers are inserted at the FRONT, so
 * they appear on top the moment they're shelved.
 *
 * Insertion scans the current orders without rewriting existing tapes. A newcomer
 * takes an order just below the minimum. Drag-reordering, which is the only thing
 * that needs a clean sequence, reindexes its list to 0..n-1. Orders drifting
 * negative over many inserts is fine — only their relative sort matters.
 */
/**
 * Orders for a block of `count` newcomers placed at the FRONT of a list whose
 * members currently hold `existingOrders`. The returned orders are all below the
 * current minimum and ascending, so the block lands on top in the given order
 * (first element = topmost). An empty list yields 0..count-1.
 */
export function frontOrders(existingOrders: number[], count: number): number[] {
  if (count <= 0) return []
  let minimum = Infinity
  for (const order of existingOrders) minimum = Math.min(minimum, order)
  const base = existingOrders.length === 0 ? 0 : minimum - count
  return Array.from({ length: count }, (_, i) => base + i)
}
