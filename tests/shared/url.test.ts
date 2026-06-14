import { describe, expect, it } from 'vitest'
import { canonicalizeForDedup, isImportableUrl, stripUrlCredentials } from '@shared/url'

describe('stripUrlCredentials', () => {
  it('strips user:password userinfo, keeping the rest of the URL', () => {
    expect(stripUrlCredentials('https://user:pass@host.example/v1?x=1')).toBe('https://host.example/v1?x=1')
  })

  it('strips a username-only credential (a token carried as the user)', () => {
    expect(stripUrlCredentials('https://sk-secret@gateway.example/v1')).toBe('https://gateway.example/v1')
  })

  it('preserves port, path, query, and fragment while dropping only the credential', () => {
    expect(stripUrlCredentials('https://u:p@host:8443/a/b?q=1#f')).toBe('https://host:8443/a/b?q=1#f')
  })

  it('returns a credential-free URL byte-identical (no normalization)', () => {
    const url = 'https://api.example.com/v1'
    expect(stripUrlCredentials(url)).toBe(url)
  })

  it('works for non-http schemes', () => {
    expect(stripUrlCredentials('ftp://u:p@host/file')).toBe('ftp://host/file')
  })

  it('returns a non-URL string unchanged (nothing to strip)', () => {
    expect(stripUrlCredentials('not a url')).toBe('not a url')
  })

  it('never lets the credential survive in the output', () => {
    const out = stripUrlCredentials('https://admin:sk-LEAK@host.test/v1')
    expect(out).not.toContain('sk-LEAK')
    expect(out).not.toContain('admin')
  })
})

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
