/**
 * Box-name rules, shared by the renderer (inline edit feedback) and the main
 * process (authoritative validation) so the rule lives in exactly one place.
 *
 * A box name must be non-empty, not a reserved word, and unique among the other
 * boxes — all compared case-insensitively after NFC normalization and trimming.
 */

/**
 * Display label for the implicit "no box" bucket. Not a real box, so it's
 * reserved: a user-created box must not shadow it. Kept here so the reserved
 * word and the label rendered in the UI can never drift apart.
 */
export const UNBOXED_LABEL = 'Unboxed'

const RESERVED_BOX_NAMES = [UNBOXED_LABEL]

export const normalizeBoxName = (name: string): string => name.normalize('NFC').trim()

/** One identity used by live validation and durable catalog validation. */
export const boxNameIdentity = (name: string): string => normalizeBoxName(name).toLowerCase()

/**
 * Validate a candidate box name. `takenNames` is the names of the *other*
 * boxes (exclude the one being renamed, so renaming to the same name is a
 * no-op, not a collision). Returns a human-readable error, or null when ok.
 */
export function boxNameError(name: string, takenNames: string[]): string | null {
  const trimmed = normalizeBoxName(name)
  if (!trimmed) return 'Enter a name.'
  const identity = boxNameIdentity(trimmed)
  if (RESERVED_BOX_NAMES.some((r) => boxNameIdentity(r) === identity)) return `"${trimmed}" is a reserved name.`
  if (takenNames.some((n) => boxNameIdentity(n) === identity)) return `A box named "${trimmed}" already exists.`
  return null
}

/**
 * Derive a unique, non-reserved name from `desired` by appending " 2", " 3", …
 * until it's free. Used to seed new boxes with a valid starting name the user
 * then overtypes.
 */
export function uniqueBoxName(desired: string, takenNames: string[]): string {
  const normalized = normalizeBoxName(desired)
  if (boxNameError(normalized, takenNames) === null) return normalized
  for (let i = 2; ; i++) {
    const candidate = `${normalized} ${i}`
    if (boxNameError(candidate, takenNames) === null) return candidate
  }
}
