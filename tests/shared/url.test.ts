import { describe, expect, it } from 'vitest'
import { stripUrlCredentials } from '@shared/url'

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
