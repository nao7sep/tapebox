import { describe, expect, it } from 'vitest'
import { join } from 'node:path'
import { sanitizeFilename } from '@main/core/filename'

/**
 * Rename and Export turn a user-typed name straight into an on-disk filename, so
 * the sanitizer is the security boundary: it must make path traversal and stray
 * separators impossible. These lock that in.
 */
describe('sanitizeFilename — path safety', () => {
  it('strips forward and back slashes so a name can never be a path', () => {
    expect(sanitizeFilename('a/b')).toBe('a b')
    expect(sanitizeFilename('a\\b')).toBe('a b')
  })

  it('neutralizes dot-dot traversal', () => {
    // Pure traversal collapses to nothing (leading/trailing dots are stripped),
    // which the callers reject as an empty name.
    expect(sanitizeFilename('..')).toBe('')
    expect(sanitizeFilename('../..')).toBe('')
    // Mixed with real segments, the separators and leading dots are gone, leaving
    // an ordinary in-directory filename.
    expect(sanitizeFilename('../../etc/passwd')).toBe('etc passwd')
    expect(sanitizeFilename('..\\..\\windows\\system32')).toBe('windows system32')
  })

  it('reduces an absolute path to a plain filename', () => {
    expect(sanitizeFilename('/etc/hosts')).toBe('etc hosts')
  })

  it('keeps every sanitized name inside the target directory once joined', () => {
    const dir = '/library'
    for (const evil of ['../../escape', '/abs/path', 'a/b/c', '..\\..\\x', '....//....//y']) {
      const safe = sanitizeFilename(evil)
      const full = join(dir, `${safe}.mp4`)
      expect(full.startsWith(`${dir}/`)).toBe(true)
      expect(full.includes('..')).toBe(false)
    }
  })
})

describe('sanitizeFilename — general rules', () => {
  it('strips reserved characters and control codes', () => {
    expect(sanitizeFilename('a<b>c:d"e|f?g*h')).toBe('a b c d e f g h')
    expect(sanitizeFilename('tab\there')).toBe('tab here')
  })

  it('preserves Unicode and collapses whitespace', () => {
    expect(sanitizeFilename('  日本語   の   動画  ')).toBe('日本語 の 動画')
  })

  it('defuses reserved DOS device names', () => {
    expect(sanitizeFilename('CON')).toBe('CON_')
    expect(sanitizeFilename('lpt1')).toBe('lpt1_')
  })

  it('returns empty when nothing usable survives, so callers can reject it', () => {
    expect(sanitizeFilename('///')).toBe('')
    expect(sanitizeFilename('   ')).toBe('')
  })
})
