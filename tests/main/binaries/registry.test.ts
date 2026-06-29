import { describe, expect, it } from 'vitest'
import { parseMartinBuildVersion } from '@main/binaries/registry'

describe('parseMartinBuildVersion', () => {
  it('extracts the version after the underscore in the build-id segment', () => {
    expect(parseMartinBuildVersion('/download/macos/arm64/1778761665_8.1.1/ffmpeg.zip')).toBe('8.1.1')
  })

  it('handles a snapshot build id (non-numeric version)', () => {
    expect(parseMartinBuildVersion('/download/macos/arm64/1781693612_N-125070-gd69e8d0a95/ffmpeg.zip'))
      .toBe('N-125070-gd69e8d0a95')
  })

  it('throws on an unrecognized path so a changed redirect surfaces as a failure', () => {
    expect(() => parseMartinBuildVersion('/download/macos/arm64/ffmpeg.zip')).toThrow(/unrecognized/)
    expect(() => parseMartinBuildVersion('/something/else.zip')).toThrow(/unrecognized/)
  })
})
