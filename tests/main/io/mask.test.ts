import { describe, expect, it } from 'vitest'
import { maskCredentials, maskUrlCredentials, maskYtdlpArgs, maskYtdlpOutput, REDACTED } from '@main/io/mask'

describe('maskYtdlpOutput', () => {
  it('keeps metadata and URL structure while masking nested login material', () => {
    const info = {
      title: 'A video about cookies', description: 'Ordinary text and "cookies": "a recipe"',
      formats: [{ cookies: 'sid=browser-secret; Domain=example.test', http_headers: {
        Authorization: 'Bearer access-secret', Cookie: 'sid=header-secret', 'Accept-Language': 'ja',
      }, url: 'https://media.test/video?id=42&sig=signed-secret&expire=99&pot=proof-secret' }],
    }
    const masked = JSON.parse(maskYtdlpOutput(JSON.stringify(info)))
    expect(masked.title).toBe(info.title)
    expect(masked.description).toBe(info.description)
    expect(masked.formats[0]).toEqual({
      cookies: REDACTED,
      http_headers: { Authorization: `Bearer ${REDACTED}`, Cookie: REDACTED, 'Accept-Language': 'ja' },
      url: `https://media.test/video?id=42&sig=${REDACTED}&expire=99&pot=${REDACTED}`,
    })
    expect(info.formats[0]!.cookies).toContain('browser-secret')
  })

  it('masks an interrupted JSON string and signed URLs in non-JSON error output', () => {
    expect(maskYtdlpOutput('{"cookies":"session=unfinished')).toBe(`{"cookies":"${REDACTED}`)
    expect(maskYtdlpOutput('ERROR https://media.test/v?signature=secret&x=1')).toBe(`ERROR https://media.test/v?signature=${REDACTED}&x=1`)
    expect(maskYtdlpOutput('ordinary non-JSON output')).toBe('ordinary non-JSON output')
  })
})

// Credentials in diagnostic copies become [REDACTED]; names, nesting and an
// authorization scheme stay (data-lifecycle conventions).

describe('maskYtdlpArgs', () => {
  it.each([
    [['--password', 'hunter22', '-f', 'best'], ['--password', REDACTED, '-f', 'best'], ['hunter22']],
    [['--password=hunter22'], [`--password=${REDACTED}`], ['hunter22']],
    [['-p', 'hunter22'], ['-p', REDACTED], ['hunter22']],
    [['-phunter22'], [`-p${REDACTED}`], ['hunter22']],
    [['--video-password', 'v1d30pass', '--twofactor', '123456'], ['--video-password', REDACTED, '--twofactor', REDACTED], ['v1d30pass', '123456']],
    [['--add-header', 'Authorization: Bearer tok3n'], ['--add-header', `Authorization: Bearer ${REDACTED}`], ['tok3n']],
    [['--add-header=Cookie: sid=abc123; theme=dark'], [`--add-header=Cookie: ${REDACTED}`], ['sid=abc123; theme=dark']],
    [['--add-header', 'Accept-Language: ja'], ['--add-header', 'Accept-Language: ja'], []],
    [['--proxy', 'http://user:secr3t@proxy.test:8080'], ['--proxy', `http://${REDACTED}@proxy.test:8080`], ['user:secr3t']],
    [['--username', 'me', '--cookies', '/home/me/cookies.txt'], ['--username', 'me', '--cookies', '/home/me/cookies.txt'], []],
  ])('masks %j', (args, masked, credentials) => {
    expect(maskYtdlpArgs(args)).toEqual({ args: masked, credentials })
  })
})

describe('maskCredentials', () => {
  it('replaces every echo of a credential at any depth, keeping keys and the original untouched', () => {
    const original = { headers: { authorization: 'Bearer sk-live-key' }, nested: ['echo sk-live-key twice sk-live-key'] }
    expect(maskCredentials(original, ['sk-live-key'])).toEqual({
      headers: { authorization: `Bearer ${REDACTED}` },
      nested: [`echo ${REDACTED} twice ${REDACTED}`],
    })
    expect(original.headers.authorization).toBe('Bearer sk-live-key')
  })

  it('masks URL logins in any string, and leaves a credential too short to search for', () => {
    expect(maskCredentials('see https://me:pw@host.test/x and abc', ['abc'])).toBe(`see https://${REDACTED}@host.test/x and abc`)
    expect(maskUrlCredentials('https://host.test/user@example')).toBe('https://host.test/user@example')
  })
})
