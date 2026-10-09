import { describe, expect, it } from 'vitest'
import { maskCredentials, maskUrlCredentials, maskYtdlpArgs, REDACTED } from '@main/io/mask'

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
