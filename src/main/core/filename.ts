/**
 * Filesystem-safe filename sanitization.
 *
 * Preserves Unicode (CJK, accented characters, etc.) but removes the
 * characters and patterns that filesystems reject. Used for export
 * filenames where the source content (e.g., a Japanese chapter title)
 * deserves to stay readable instead of collapsing into an empty ASCII slug.
 *
 * Rules — chosen as the cross-platform intersection:
 *   - Strip reserved characters: < > : " / \ | ? *
 *   - Strip ASCII control characters (0x00–0x1F) and DEL (0x7F)
 *   - Collapse internal whitespace runs to a single space
 *   - Trim leading/trailing whitespace and dots (Windows refuses these)
 *   - Reject reserved DOS device names (CON, PRN, AUX, NUL, COM1–9, LPT1–9)
 *     by appending an underscore — the file still opens, just not as a
 *     pipe to that device.
 *   - Truncate so the byte length fits within 240 bytes when UTF-8 encoded.
 *     Headroom under typical 255-byte limits and well under Windows 255-char
 *     filename limit. Truncation never splits a Unicode code point.
 *
 * If the input collapses to empty (all-reserved characters), the caller
 * gets an empty string and is expected to substitute a fallback (index
 * number, source id, etc.).
 */

const RESERVED_CHARS = /[<>:"/\\|?*\x00-\x1f\x7f]/g

const RESERVED_DOS_NAMES = new Set([
  'con', 'prn', 'aux', 'nul',
  'com1', 'com2', 'com3', 'com4', 'com5', 'com6', 'com7', 'com8', 'com9',
  'lpt1', 'lpt2', 'lpt3', 'lpt4', 'lpt5', 'lpt6', 'lpt7', 'lpt8', 'lpt9',
])

const MAX_BYTES = 240

export { portableFilenameIdentity } from '@shared/filename'
import { portableFilenameIdentity } from '@shared/filename'

export function sanitizeFilename(input: string): string {
  let s = input.normalize('NFC')
  s = s.replace(RESERVED_CHARS, ' ')
  s = s.replace(/\s+/g, ' ')
  s = s.replace(/^[\s.]+|[\s.]+$/g, '')

  if (s.length === 0) return ''

  const lowerBase = portableFilenameIdentity(s.replace(/\.[^.]*$/, ''))
  if (RESERVED_DOS_NAMES.has(lowerBase)) {
    s = `${s}_`
  }

  return truncateUtf8Bytes(s, MAX_BYTES)
}

/**
 * Truncate a string so its UTF-8 byte length does not exceed maxBytes,
 * stopping at a code-point boundary so we never split a surrogate pair
 * or multi-byte sequence.
 */
function truncateUtf8Bytes(s: string, maxBytes: number): string {
  const encoder = new TextEncoder()
  if (encoder.encode(s).length <= maxBytes) return s

  // Binary-search by code-point index for the longest prefix that fits.
  const codePoints = Array.from(s)
  let lo = 0
  let hi = codePoints.length
  while (lo < hi) {
    const mid = (lo + hi + 1) >>> 1
    const candidate = codePoints.slice(0, mid).join('')
    if (encoder.encode(candidate).length <= maxBytes) {
      lo = mid
    } else {
      hi = mid - 1
    }
  }
  return codePoints.slice(0, lo).join('')
}
