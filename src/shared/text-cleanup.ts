// The single-line and multiline patterns of the text-cleanup-conventions, copied
// from the company reference implementation. Cleanup runs when settings are
// saved, never while the user is typing.

/**
 * Clean a scalar value. Always trims the ends.
 *
 * - `flattenLineBreaks` (default true): every whitespace run containing a line break
 *   becomes one ASCII space, so a value pasted across lines becomes one line.
 * - `minify` (default false): every whitespace run becomes one ASCII space.
 */
export function singleLine(
  text: string,
  opts: { flattenLineBreaks?: boolean; minify?: boolean } = {},
): string {
  const { flattenLineBreaks = true, minify = false } = opts
  if (minify) return text.replace(/\s+/g, ' ').trim()
  if (flattenLineBreaks) return text.replace(/\s*[\r\n]+\s*/g, ' ').trim()
  return text.trim()
}

/**
 * Clean a multi-line body where line structure carries meaning. Indentation is
 * always kept and line endings become `\n`.
 *
 * - `trimLineEnds` (default true): drop each line's trailing whitespace.
 * - `dropEdgeBlankLines` (default true): drop blank lines before the first and
 *   after the last visible line.
 * - `collapseBlankLines` (default false): reduce interior runs of blank lines to one.
 */
export function multiline(
  text: string,
  opts: { trimLineEnds?: boolean; dropEdgeBlankLines?: boolean; collapseBlankLines?: boolean } = {},
): string {
  const { trimLineEnds = true, dropEdgeBlankLines = true, collapseBlankLines = false } = opts
  const isBlank = (line: string) => line.trim() === ''
  let lines = text.split(/\r\n|\r|\n/)
  if (trimLineEnds) lines = lines.map((line) => line.replace(/\s+$/, ''))
  let start = 0
  let end = lines.length
  if (dropEdgeBlankLines) {
    while (start < end && isBlank(lines[start]!)) start++
    while (end > start && isBlank(lines[end - 1]!)) end--
  }
  const out: string[] = []
  let prevBlank = false
  for (const line of lines.slice(start, end)) {
    const blank = isBlank(line)
    if (collapseBlankLines && blank && prevBlank) continue
    out.push(line)
    prevBlank = blank
  }
  return out.join('\n')
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
