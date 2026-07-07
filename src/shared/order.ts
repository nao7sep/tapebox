/**
 * Manual ordering primitive shared by every list of tapes — the inbox, a box,
 * and Unboxed. Each tape carries an `order` (lower = nearer the top); a list is
 * rendered sorted ascending by it. New tapes are inserted at the FRONT, so they
 * appear on top the moment they're added — like new mail in Thunderbird.
 *
 * Inserts stay O(1): a newcomer takes an order just below the current minimum,
 * never touching the existing tapes. Drag-reordering, which is the only thing
 * that needs a clean sequence, reindexes its list to 0..n-1 (see the renderer's
 * drag handlers + the tapes:reorder handler). Orders drifting negative over many
 * inserts is fine — only their relative sort matters.
 */

/**
 * Orders for a block of `count` newcomers placed at the FRONT of a list whose
 * members currently hold `existingOrders`. The returned orders are all below the
 * current minimum and ascending, so the block lands on top in the given order
 * (first element = topmost). An empty list yields 0..count-1.
 */
export function frontOrders(existingOrders: number[], count: number): number[] {
  if (count <= 0) return []
  const base = existingOrders.length === 0 ? 0 : Math.min(...existingOrders) - count
  return Array.from({ length: count }, (_, i) => base + i)
}
