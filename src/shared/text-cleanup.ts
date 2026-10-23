// Cleanup runs when settings are saved, never while the user is typing.

/** Trim scalar ends and flatten line breaks without collapsing interior spaces. */
export function singleLine(text: string): string {
  return text.replace(/\s*[\r\n]+\s*/g, ' ').trim()
}

/** Keep indentation and interior blank lines, normalize line endings, and drop
 * trailing line whitespace and blank lines at the edges. */
export function multiline(text: string): string {
  const lines = text.split(/\r\n|\r|\n/).map((line) => line.replace(/\s+$/, ''))
  let start = 0
  let end = lines.length
  while (start < end && lines[start]!.trim() === '') start++
  while (end > start && lines[end - 1]!.trim() === '') end--
  return lines.slice(start, end).join('\n')
}

/**
 * Shorten displayed text to at most `n` graphemes, never splitting one, with
 * whitespace runs read as single spaces. `truncated` reports whether visible text
 * was cut, so a caller appends "…" only then (localization-conventions, Ellipsis).
 */
export function truncate(text: string, n: number): { text: string; truncated: boolean } {
  if (n <= 0) return { text: '', truncated: false }
  const out: string[] = []
  let pendingSpace = false
  let budgetMet = false
  let truncated = false
  for (const { segment } of new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(text)) {
    const isWhitespace = segment.trim() === ''
    if (!budgetMet) {
      if (isWhitespace) {
        if (out.length > 0) pendingSpace = true
        continue
      }
      // A separator is useful only with its following visible grapheme. Keep
      // both out when they cannot fit, so the result never ends with a space.
      if (pendingSpace && out.length + 2 > n) {
        truncated = true
        break
      }
      if (pendingSpace) { out.push(' '); pendingSpace = false }
      out.push(segment)
      if (out.length >= n) budgetMet = true
    } else if (!isWhitespace) {
      truncated = true
      break
    }
  }
  return { text: out.join(''), truncated }
}
