/**
 * Box-name rules, shared by the renderer (inline edit feedback) and the main
 * process (authoritative validation) so the rule lives in exactly one place.
 *
 * A box name must be non-empty, not a reserved word, and unique among the other
 * boxes — all compared case-insensitively after trimming.
 */

/**
 * Display label for the implicit "no box" bucket. Not a real box, so it's
 * reserved: a user-created box must not shadow it. Kept here so the reserved
 * word and the label rendered in the UI can never drift apart.
 */
export const UNBOXED_LABEL = 'Unboxed'

const RESERVED_BOX_NAMES = [UNBOXED_LABEL]

const norm = (s: string) => s.trim().toLowerCase()

/**
 * Validate a candidate box name. `takenNames` is the names of the *other*
 * boxes (exclude the one being renamed, so renaming to the same name is a
 * no-op, not a collision). Returns a human-readable error, or null when ok.
 */
export function boxNameError(name: string, takenNames: string[]): string | null {
  const trimmed = name.trim()
  if (!trimmed) return 'Enter a name.'
  const lower = norm(trimmed)
  if (RESERVED_BOX_NAMES.some((r) => norm(r) === lower)) return `"${trimmed}" is a reserved name.`
  if (takenNames.some((n) => norm(n) === lower)) return `A box named "${trimmed}" already exists.`
  return null
}

/**
 * Derive a unique, non-reserved name from `desired` by appending " 2", " 3", …
 * until it's free. Used to seed new boxes with a valid starting name the user
 * then overtypes.
 */
export function uniqueBoxName(desired: string, takenNames: string[]): string {
  if (boxNameError(desired, takenNames) === null) return desired
  for (let i = 2; ; i++) {
    const candidate = `${desired} ${i}`
    if (boxNameError(candidate, takenNames) === null) return candidate
  }
}
