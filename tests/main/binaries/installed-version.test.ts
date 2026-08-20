/**
 * The installed version is read from the ARTIFACT, never from the facts store
 * (managed-runtime-dependencies-conventions). What that buys, pinned here:
 *
 *  - a binary the app has no record of installing still reports its true version,
 *    which is the defect this replaced — tapebox's own ~/.tapebox/bin held yt-dlp,
 *    ffmpeg and deno while dependencies.json recorded installedVersion: null for
 *    all three, pinning every tool at "installed (not checked)" forever;
 *  - a probe is a subprocess spawn, so it runs once per process and again only
 *    after an install replaces the binary;
 *  - a FAILED read is null, not a version and not silently "current".
 *
 * `paths`/`binaryPath` point at a throwaway bin dir and `execCapture` is stubbed,
 * so the spawn is counted rather than performed and the test is the same on every
 * platform.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const home = vi.hoisted(() => ({ bin: '' }))
const capture = vi.hoisted(() => ({
  calls: [] as { command: string; args: readonly string[] }[],
  result: null as { stdout: string; exitCode: number } | null,
  error: null as Error | null,
}))

vi.mock('@main/paths', async () => {
  const { join: joinPath } = await import('node:path')
  return {
    paths: {
      get bin() {
        return home.bin
      },
    },
    binaryPath: (name: string) => joinPath(home.bin, name),
  }
})

vi.mock('@main/io/spawn', () => ({
  execCapture: vi.fn(async (command: string, args: readonly string[]) => {
    capture.calls.push({ command, args })
    if (capture.error) throw capture.error
    return { stdout: capture.result?.stdout ?? '', stderr: '', exitCode: capture.result?.exitCode ?? 0 }
  }),
}))

vi.mock('@main/io/logger', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))

vi.mock('@main/binaries/registry', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@main/binaries/registry')>()
  return {
    ...actual,
    binarySpecs: {
      // A probe-read binary and a sidecar-read one, so both mechanisms are covered
      // regardless of which platform decides ffmpeg's source in the real registry.
      'yt-dlp': {
        name: 'yt-dlp',
        resolveLatest: vi.fn(),
        installedVersion: { kind: 'probe', args: ['--version'], parse: actual.parseYtDlpVersion },
      },
      deno: {
        name: 'deno',
        resolveLatest: vi.fn(),
        installedVersion: { kind: 'probe', args: ['--version'], parse: actual.parseDenoVersion },
      },
      ffmpeg: { name: 'ffmpeg', resolveLatest: vi.fn(), installedVersion: { kind: 'sidecar' } },
    },
  }
})

import {
  forgetAllInstalledVersions,
  forgetInstalledVersion,
  readInstalledVersion,
  versionSidecarPath,
  writeVersionSidecar,
} from '@main/binaries/installed-version'

beforeEach(() => {
  home.bin = mkdtempSync(join(tmpdir(), 'tapebox-bin-'))
  capture.calls = []
  capture.result = null
  capture.error = null
  forgetAllInstalledVersions()
})

afterEach(() => {
  rmSync(home.bin, { recursive: true, force: true })
})

describe('probing the binary', () => {
  it('reports the version a binary the app never recorded installing prints', async () => {
    capture.result = { stdout: '2026.07.04\n', exitCode: 0 }
    // Nothing was persisted about this binary — that is exactly the case the old
    // model could not represent.
    expect(await readInstalledVersion('yt-dlp')).toBe('2026.07.04')
    expect(capture.calls).toEqual([{ command: join(home.bin, 'yt-dlp'), args: ['--version'] }])
  })

  it('normalizes what it reads, so it compares against the resolved latest', async () => {
    capture.result = { stdout: 'deno v2.9.5 (stable, release, aarch64-apple-darwin)\n', exitCode: 0 }
    expect(await readInstalledVersion('deno')).toBe('2.9.5')
  })

  it('spawns once per process, however many readers ask', async () => {
    capture.result = { stdout: '2026.07.04\n', exitCode: 0 }
    const [a, b, c] = await Promise.all([
      readInstalledVersion('yt-dlp'),
      readInstalledVersion('yt-dlp'),
      readInstalledVersion('yt-dlp'),
    ])
    expect([a, b, c]).toEqual(['2026.07.04', '2026.07.04', '2026.07.04'])
    expect(capture.calls).toHaveLength(1)
  })

  it('re-reads after an install drops the cached answer', async () => {
    capture.result = { stdout: '2026.07.04\n', exitCode: 0 }
    expect(await readInstalledVersion('yt-dlp')).toBe('2026.07.04')

    forgetInstalledVersion('yt-dlp')
    capture.result = { stdout: '2026.08.19\n', exitCode: 0 }
    expect(await readInstalledVersion('yt-dlp')).toBe('2026.08.19')
    expect(capture.calls).toHaveLength(2)
  })
})

// A failure is not a version and not "up to date": null has nothing to compare, so
// the derivation holds the row at installed-unchecked and the surface offers the
// re-acquire that fixes it.
describe('a read that fails', () => {
  it('is null when the binary cannot be run at all', async () => {
    capture.error = new Error('spawn ENOENT')
    expect(await readInstalledVersion('yt-dlp')).toBeNull()
  })

  it('is null when the binary exits non-zero', async () => {
    capture.result = { stdout: '', exitCode: 1 }
    expect(await readInstalledVersion('yt-dlp')).toBeNull()
  })

  it('is null when the output is not a version, rather than storing the noise', async () => {
    capture.result = { stdout: 'Usage: yt-dlp [OPTIONS] URL\n', exitCode: 0 }
    expect(await readInstalledVersion('yt-dlp')).toBeNull()
  })

  it('does not remember a failure past an install', async () => {
    capture.error = new Error('spawn ENOENT')
    expect(await readInstalledVersion('yt-dlp')).toBeNull()

    forgetInstalledVersion('yt-dlp')
    capture.error = null
    capture.result = { stdout: '2026.08.19\n', exitCode: 0 }
    expect(await readInstalledVersion('yt-dlp')).toBe('2026.08.19')
  })
})

describe('the sidecar, where a binary cannot report itself', () => {
  it('round-trips the version recorded beside the binary, without spawning it', async () => {
    await writeVersionSidecar('ffmpeg', 'Latest Auto-Build (2026-08-19 19:21)')
    expect(await readInstalledVersion('ffmpeg')).toBe('Latest Auto-Build (2026-08-19 19:21)')
    expect(capture.calls).toHaveLength(0)
  })

  it('is <stem>.json beside the binary, not a suffix on its full filename', () => {
    expect(versionSidecarPath('ffmpeg')).toBe(join(home.bin, 'ffmpeg.json'))
  })

  it('is null when absent — a hand-placed binary is unversioned, never assumed current', async () => {
    expect(await readInstalledVersion('ffmpeg')).toBeNull()
  })

  it('is null when unreadable or empty, rather than a blank version', async () => {
    writeFileSync(versionSidecarPath('ffmpeg'), '{ not json')
    expect(await readInstalledVersion('ffmpeg')).toBeNull()

    forgetInstalledVersion('ffmpeg')
    writeFileSync(versionSidecarPath('ffmpeg'), JSON.stringify({ version: '  ' }))
    expect(await readInstalledVersion('ffmpeg')).toBeNull()
  })
})
