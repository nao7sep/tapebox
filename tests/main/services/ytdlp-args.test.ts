import { describe, it, expect, vi, beforeEach } from 'vitest'

import type { SiteProfile } from '@shared/settings'

// resolveYtdlpArgs reads settings; mock the store so the resolver is testable in
// isolation. tokenizeArgs/matches are pure and need no mock.
const getSettings = vi.fn()
vi.mock('@main/store/config', () => ({ getSettings: () => getSettings() }))

import { tokenizeArgs, matches, resolveYtdlpArgs } from '@main/services/ytdlp-args'

const profile = (over: Partial<SiteProfile>): SiteProfile => ({
  id: 'p',
  name: 'p',
  urlPattern: '',
  isRegex: false,
  args: '',
  comment: '',
  ...over,
})

describe('tokenizeArgs', () => {
  it('splits on whitespace including newlines', () => {
    expect(tokenizeArgs('--no-part --newline')).toEqual(['--no-part', '--newline'])
    expect(tokenizeArgs('a\nb\tc')).toEqual(['a', 'b', 'c'])
  })

  it('groups a quoted value in both the separated and glued forms', () => {
    expect(tokenizeArgs('--add-header "Accept-Language: ja"')).toEqual([
      '--add-header',
      'Accept-Language: ja',
    ])
    expect(tokenizeArgs('--extractor-args="site:lang=ja"')).toEqual(['--extractor-args=site:lang=ja'])
    expect(tokenizeArgs("--x 'a b'")).toEqual(['--x', 'a b'])
  })

  it('keeps backslashes literal (Windows paths survive intact)', () => {
    expect(tokenizeArgs('--ffmpeg-location C:\\tools\\bin')).toEqual([
      '--ffmpeg-location',
      'C:\\tools\\bin',
    ])
  })

  it('produces an empty token for an empty quoted value', () => {
    expect(tokenizeArgs('--x ""')).toEqual(['--x', ''])
  })

  it('cannot embed a literal quote inside a value (documented limitation)', () => {
    // The quote is always a delimiter, never a literal — so `a"b` collapses to `ab`,
    // never a token containing a quote character.
    const tokens = tokenizeArgs('a"b"c')
    expect(tokens).toEqual(['abc'])
    expect(tokens.some((t) => t.includes('"'))).toBe(false)
  })
})

describe('matches', () => {
  it('never matches an empty pattern', () => {
    expect(matches(profile({ urlPattern: '' }), 'https://example.com')).toBe(false)
  })

  it('does a substring match when isRegex is off', () => {
    expect(matches(profile({ urlPattern: 'example.com' }), 'https://example.com/x')).toBe(true)
    expect(matches(profile({ urlPattern: 'other' }), 'https://example.com')).toBe(false)
  })

  it('does a regex match when isRegex is on', () => {
    expect(matches(profile({ urlPattern: '^https://(ja|en)\\.example\\.com', isRegex: true }), 'https://ja.example.com')).toBe(true)
  })

  it('treats a malformed regex as no match (never throws)', () => {
    expect(matches(profile({ urlPattern: '(unclosed', isRegex: true }), 'https://example.com')).toBe(false)
  })
})

describe('resolveYtdlpArgs', () => {
  beforeEach(() => getSettings.mockReset())

  it('returns the global args alone when no profile matches', () => {
    getSettings.mockReturnValue({ ytdlpArgs: '--no-part', siteProfiles: [] })
    expect(resolveYtdlpArgs('https://example.com')).toEqual(['--no-part'])
  })

  it('appends the first matching profile after the globals (profile wins on conflict)', () => {
    getSettings.mockReturnValue({
      ytdlpArgs: '--sleep-interval 1',
      siteProfiles: [profile({ urlPattern: 'example.com', args: '--sleep-interval 5' })],
    })
    expect(resolveYtdlpArgs('https://example.com/v')).toEqual([
      '--sleep-interval',
      '1',
      '--sleep-interval',
      '5',
    ])
  })
})
