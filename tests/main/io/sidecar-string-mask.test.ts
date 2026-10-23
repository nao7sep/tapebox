import { describe, expect, it } from 'vitest'
import { SidecarStringMask } from '@main/io/sidecar-string-mask'
import { maskUrlCredentials, maskYtdlpOutput, REDACTED } from '@main/io/mask'

function legacy(text: string): string {
  return (JSON.parse(maskUrlCredentials(maskYtdlpOutput(JSON.stringify({ value: text })))) as { value: string }).value
}
function stream(chunks: string[]): string {
  const mask = new SidecarStringMask()
  return chunks.map((chunk) => mask.feed(chunk)).join('') + mask.end()
}
// Inspect retained strings after feed settles, excluding output owned by the
// caller. A huge test must fail if a future implementation buffers whole values.
function retainedCharacters(value: object): number {
  return Object.values(value).reduce((count, child: unknown) => count + (
    typeof child === 'string' ? child.length : child !== null && typeof child === 'object' ? retainedCharacters(child) : 0
  ), 0)
}

const fixtures = [
  'Ordinary metadata about cookies, sig=outside and someone@example.test.',
  'https://media.test/video?id=42&sig=signed-secret&expire=99&pot=proof-secret#chapter-2',
  'HTTP://user:password@media.test/v?SIGNATURE=first&lsig=second&sig=&pot=last',
  'socks5+proxy://name:password@proxy.test:8080 and ftp://user@server.test/file',
  'https://host.test/path/user@example.test?sig=token#fragment&ordinary=value',
  'First https://user:pw@one.test/?sig=one then https://two.test/v?pot=two&keep=yes.',
  'https://[REDACTED]@host.test/?sig=[REDACTED]&pot=[REDACTED]#kept',
  'A title 日本語 😀 https://利用者:秘密@例え.test/動画?sig=署名&keep=値#目次',
  'https://host.test/v?signature-extra=keep&signatures=keep&sig=hide&pottery=keep',
  'https://host.test/v?sig=secret"Quoted title" https://another.test/?pot=secret\\local',
  'https://host.test/v?sig=first\nhttps://user:pw@other.test/?pot=second\tEnd',
  'https://user:pw@host.test',
  'https://host.test',
  'https://user:unfinished',
  'https://@host.test/ and https://first@second@host.test/',
  'https://host.test/?sig=&lsig=#fragment?pot=secret&kept=yes',
  'Text ftp://user:password@host.test/?sig=not-an-http-secret',
  'https://outer.test/ftp://name:secret@inner.test/file?sig=secret',
  '123://ordinary@host and 1ftp://user:secret@host.test/path',
  'https://',
  'ftp:/unfinished and https:/unfinished',
  'prefixhttps://user:pw@host.test/?sig=secret&keep=true',
]

describe('SidecarStringMask', () => {
  it.each(fixtures)('preserves the legacy diagnostic URL masking across every two-way split: %s', (text) => {
    const expected = legacy(text)
    for (let split = 0; split <= text.length; split++) {
      expect(stream([text.slice(0, split), '', text.slice(split)]), `split ${split}`).toBe(expected)
    }
    expect(stream(text.split(''))).toBe(expected)
    for (const size of [2, 3, 7, 13]) {
      const chunks = []
      for (let at = 0; at < text.length; at += size) chunks.push(text.slice(at, at + size))
      expect(stream(chunks)).toBe(expected)
    }
  })

  it('emits scheme and ordinary text immediately and resolves only candidate authorities at end', () => {
    const mask = new SidecarStringMask()
    expect(mask.feed('Title https://')).toBe('Title https://')
    expect(mask.feed('host.test')).toBe('')
    expect(mask.end()).toBe('host.test')
    expect(mask.end()).toBe('')
    expect(stream(['https://user', ':password', '@host', '.test/path'])).toBe(`https://${REDACTED}@host.test/path`)
  })

  it('does not retain a huge ordinary metadata string or an arbitrarily long scheme', () => {
    const mask = new SidecarStringMask()
    const chunk = '日本語 plain metadata '.repeat(1024)
    for (let index = 0; index < 512; index++) {
      expect(mask.feed(chunk)).toBe(chunk)
      expect(retainedCharacters(mask)).toBeLessThan(32)
    }
    const scheme = 'a'.repeat(8192)
    expect(mask.feed(scheme)).toBe(scheme)
    expect(retainedCharacters(mask)).toBeLessThan(32)
    expect(mask.feed('://user:secret@host/path')).toBe(`://${REDACTED}@host/path`)
    expect(mask.end()).toBe('')
  })

  it('discards huge signed parameter values while preserving following parameters and fragments', () => {
    const mask = new SidecarStringMask()
    expect(mask.feed('https://host.test/video?sig=')).toBe(`https://host.test/video?sig=${REDACTED}`)
    const secret = 'secret-material'.repeat(1024)
    for (let index = 0; index < 512; index++) {
      expect(mask.feed(secret)).toBe('')
      expect(retainedCharacters(mask)).toBeLessThan(32)
    }
    expect(mask.feed('&keep=visible#fragment')).toBe('&keep=visible#fragment')
    expect(mask.end()).toBe('')
  })

  it('ends candidate authority at unsafe text delimiters', () => {
    for (const delimiter of ['/', '?', '#', ' ', '"', '<', '>', '\\']) {
      expect(stream([`ftp://host${delimiter}`, 'name@elsewhere'])).toBe(`ftp://host${delimiter}name@elsewhere`)
    }
  })
})
