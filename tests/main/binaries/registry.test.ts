import { describe, expect, it } from 'vitest'
import {
  normalizeVersion,
  parseDenoVersion,
  parseFfmpegVersion,
  parseMartinBuildVersion,
  parseYtDlpVersion,
} from '@main/binaries/registry'

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

// The installed version is read back from the binary, so the two sides of the
// comparison now come from different sources and only agree once normalized. Each
// case below is the tool's REAL output, captured from ~/.tapebox/bin.
describe('normalizeVersion', () => {
  it('drops the martin-riedl builder suffix ffmpeg appends to its version', () => {
    expect(normalizeVersion('8.1.2-https://www.martin-riedl.de')).toBe('8.1.2')
  })

  it('drops the leading v a release tag carries and the binary does not', () => {
    expect(normalizeVersion('v2.9.5')).toBe('2.9.5')
  })

  it('leaves an already-bare version alone', () => {
    expect(normalizeVersion('  2026.08.19  ')).toBe('2026.08.19')
  })
})

describe('parseYtDlpVersion', () => {
  it('reads the bare date version yt-dlp prints', () => {
    expect(parseYtDlpVersion('2026.07.04\n')).toBe('2026.07.04')
  })

  it('reads a nightly build', () => {
    expect(parseYtDlpVersion('2026.07.04.232303\n')).toBe('2026.07.04.232303')
  })

  it('refuses output that is not a version, rather than inventing one', () => {
    expect(parseYtDlpVersion('Usage: yt-dlp [OPTIONS] URL')).toBeNull()
    expect(parseYtDlpVersion('')).toBeNull()
  })
})

describe('parseFfmpegVersion', () => {
  it('reads the version out of the banner and drops the builder suffix', () => {
    const banner =
      'ffmpeg version 8.1.2-https://www.martin-riedl.de Copyright (c) 2000-2026 the FFmpeg developers\n' +
      'built with Apple clang version 14.0.0\n'
    expect(parseFfmpegVersion(banner)).toBe('8.1.2')
  })

  it('refuses a banner it does not recognize', () => {
    expect(parseFfmpegVersion('ffprobe version 8.1.2 Copyright')).toBeNull()
    expect(parseFfmpegVersion('')).toBeNull()
  })
})

describe('parseDenoVersion', () => {
  it('reads the version off the first line of the three-line banner', () => {
    const banner =
      'deno 2.9.1 (stable, release, aarch64-apple-darwin)\nv8 14.9.207.2-rusty\ntypescript 6.0.3\n'
    expect(parseDenoVersion(banner)).toBe('2.9.1')
  })

  it('normalizes to the same form the release tag reduces to', () => {
    expect(parseDenoVersion('deno v2.9.5 (stable)')).toBe(normalizeVersion('v2.9.5'))
  })

  it('refuses output that is not deno', () => {
    expect(parseDenoVersion('command not found')).toBeNull()
  })
})
