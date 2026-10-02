import { describe, expect, it } from 'vitest'
import { canonicalizeForDedup, isImportableUrl } from '@shared/url'

describe('isImportableUrl', () => {
  it('accepts http(s) URLs', () => {
    expect(isImportableUrl('https://example.com/watch?v=1')).toBe(true)
    expect(isImportableUrl('http://localhost:8080/x')).toBe(true)
  })

  it('rejects non-web schemes and garbage', () => {
    expect(isImportableUrl('file:///etc/passwd')).toBe(false)
    expect(isImportableUrl('ftp://host/x')).toBe(false)
    expect(isImportableUrl('not a url')).toBe(false)
    expect(isImportableUrl('')).toBe(false)
  })
})

describe('canonicalizeForDedup', () => {
  it('drops tracking params and the fragment so variants of one link collapse', () => {
    const clean = 'https://www.youtube.com/watch?v=abc'
    expect(canonicalizeForDedup('https://www.youtube.com/watch?v=abc&si=track123#t=10')).toBe(clean)
    expect(canonicalizeForDedup('https://www.youtube.com/watch?v=abc&utm_source=x&fbclid=y')).toBe(clean)
  })

  it('preserves content-selecting params (v, t, list)', () => {
    const u = 'https://www.youtube.com/watch?v=abc&t=30&list=PL1'
    expect(canonicalizeForDedup(u)).toBe(u)
  })

  it('treats http vs https and host case as the parser normalizes (scheme/host lowercased)', () => {
    expect(canonicalizeForDedup('https://Example.COM/Path')).toBe('https://example.com/Path')
  })

  it('returns a non-URL string trimmed', () => {
    expect(canonicalizeForDedup('  not a url  ')).toBe('not a url')
  })
})
