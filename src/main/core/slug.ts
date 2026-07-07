/**
 * Slug normalization.
 *
 * The rename feature accepts any filesystem-safe name (sanitizeFilename in
 * core/filename.ts), so this is only used to clean up an AI suggestion into a
 * tidy slug the user can then accept or edit: lowercase ASCII letters, digits,
 * and hyphens — no leading/trailing or consecutive hyphens. Length capped at 80
 * characters, well under filesystem limits and still descriptive.
 */

export function slugifyAscii(input: string): string {
  // First line only; strip surrounding quotes/code-fence characters.
  const firstLine = (input.split('\n')[0] ?? '').trim()
  const unquoted = firstLine.replace(/^["'`]+|["'`]+$/g, '').trim()
  return unquoted
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80)
    .replace(/-+$/g, '')
}
