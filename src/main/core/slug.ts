/**
 * Slug normalization + validation.
 *
 * Slugs are lowercase ASCII letters, digits, and hyphens. They must not start
 * or end with a hyphen and may not contain consecutive hyphens. Length capped
 * at 80 characters — well under filesystem limits and still descriptive.
 */

export function normalizeSlug(input: string): string {
  // First line only; strip surrounding quotes/code-fence characters.
  const firstLine = (input.split('\n')[0] ?? '').trim()
  const unquoted = firstLine.replace(/^["'`]+|["'`]+$/g, '').trim()
  return unquoted
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80)
    .replace(/-+$/g, '') // re-trim if slicing left a trailing hyphen
}

export function isValidSlug(s: string): boolean {
  if (s.length === 0 || s.length > 80) return false
  return /^[a-z0-9]+(-[a-z0-9]+)*$/.test(s)
}
