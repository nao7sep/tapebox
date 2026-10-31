/**
 * The installed version is read from the ARTIFACT, never from the facts store
 * (managed-runtime-dependencies-conventions). What that buys, pinned here:
 *
 *  - a binary the app has no record of installing still reports its true version,
 *    which is the defect this replaced — tapebox's own ~/.tapebox/bin held yt-dlp,
 *    ffmpeg and deno while dependencies.json recorded installedVersion: null for
 *    all three, pinning every tool at "installed (not checked)" forever;
 *  - concurrent probes share one read; successful observations remain cached,
 *    while an unavailable probe can recover on the next deliberate read;
 *  - a FAILED read is null, not a version and not silently "current".
 *
 * `paths`/`binaryPath` point at a throwaway bin dir and `execCapture` is stubbed,
 * so the spawn is counted rather than performed and the test is the same on every
 * platform.
 */

import { execCapture } from '@main/io/spawn'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { header } from '../../helpers/file-header'

const home = vi.hoisted(() => ({ bin: '' }))
const capture = vi.hoisted(() => ({
  calls: [] as { command: string; args: readonly string[] }[],
  idleTimeouts: [] as (number | undefined)[],
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
  execCapture: vi.fn(
    async (command: string, args: readonly string[], options?: { idleTimeoutMs?: number }) => {
      capture.calls.push({ command, args })
      capture.idleTimeouts.push(options?.idleTimeoutMs)
      if (capture.error) throw capture.error
      return { stdout: capture.result?.stdout ?? '', stderr: '', exitCode: capture.result?.exitCode ?? 0 }
    },
  ),
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
      ffmpeg: { name: 'ffmpeg', resolveLatest: vi.fn(), installedVersion: { kind: 'sidecar', parse: actual.parseFfmpegBuildTag } },
    },
  }
})

import {
  forgetInstalledVersion,
  readInstalledVersion,
  versionSidecarPath,
  writeVersionSidecar,
} from '@main/binaries/installed-version'

beforeEach(() => {
  home.bin = mkdtempSync(join(tmpdir(), 'tapebox-bin-'))
  writeFileSync(join(home.bin, 'ffmpeg'), 'installed executable bytes')
  capture.calls = []
  capture.idleTimeouts = []
  capture.result = null
  capture.error = null
  for (const name of ['yt-dlp', 'deno', 'ffmpeg'] as const) forgetInstalledVersion(name)
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
    expect(capture.idleTimeouts).toEqual([30_000])
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
  it('retries an unavailable probe without requiring a reinstall', async () => {
    capture.error = new Error('probe timed out')
    expect(await readInstalledVersion('yt-dlp')).toBeNull()
    capture.error = null
    capture.result = { stdout: '2026.08.19', exitCode: 0 }
    expect(await readInstalledVersion('yt-dlp')).toBe('2026.08.19')
    expect(await readInstalledVersion('yt-dlp')).toBe('2026.08.19')
    expect(capture.calls).toHaveLength(2)
  })

  it('keeps an install generation when an older unavailable probe settles late', async () => {
    let fail!: (error: Error) => void
    vi.mocked(execCapture).mockImplementationOnce(() => new Promise((_resolve, reject) => { fail = reject }))
    const old = readInstalledVersion('yt-dlp')
    expect(readInstalledVersion('yt-dlp')).toBe(old)
    forgetInstalledVersion('yt-dlp')
    capture.result = { stdout: '2026.08.19', exitCode: 0 }
    const current = readInstalledVersion('yt-dlp')
    expect(await current).toBe('2026.08.19')
    fail(new Error('old timeout'))
    expect(await old).toBeNull()
    expect(readInstalledVersion('yt-dlp')).toBe(current)
  })

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
  it('round-trips the build tag recorded beside the binary, without spawning it', async () => {
    await writeVersionSidecar('ffmpeg', 'autobuild-2026-08-19-19-21')
    expect(await readInstalledVersion('ffmpeg')).toBe('autobuild-2026-08-19-19-21')
    expect(capture.calls).toHaveLength(0)
  })

  it('does not label a replacement binary with the old sidecar version', async () => {
    await writeVersionSidecar('ffmpeg', 'autobuild-2026-08-19-19-21')
    writeFileSync(join(home.bin, 'ffmpeg'), 'replacement executable bytes')
    expect(await readInstalledVersion('ffmpeg')).toBeNull()
  })

  it('treats an old unbound sidecar as an unknown version', async () => {
    writeFileSync(versionSidecarPath('ffmpeg'), JSON.stringify({ ...header('binaryVersion'), version: 'autobuild-2026-08-19-19-21' }))
    expect(await readInstalledVersion('ffmpeg')).toBeNull()
  })

  it('cancels hashing without publishing a sidecar', async () => {
    const controller = new AbortController()
    controller.abort(new DOMException('cancelled', 'AbortError'))
    await expect(writeVersionSidecar('ffmpeg', 'autobuild-2026-08-19-19-21', controller.signal)).rejects.toMatchObject({ name: 'AbortError' })
    expect(() => readFileSync(versionSidecarPath('ffmpeg'))).toThrow()
  })

  it('reads anything but a build tag as unreadable, so the row offers Update', async () => {
    for (const stored of ['Latest Auto-Build (2026-08-19 19:21)', 'Auto-Build 2026-08-19 19:21', 'N-119123-gabc']) {
      forgetInstalledVersion('ffmpeg')
      await writeVersionSidecar('ffmpeg', stored)
      expect(await readInstalledVersion('ffmpeg'), stored).toBeNull()
    }
  })

  it('is <stem>.json beside the binary, not a suffix on its full filename', () => {
    expect(versionSidecarPath('ffmpeg')).toBe(join(home.bin, 'ffmpeg.json'))
  })

  it('is null when absent — a hand-placed binary is unversioned, never assumed current', async () => {
    expect(await readInstalledVersion('ffmpeg')).toBeNull()
  })

  it('reads a sidecar without its format marker as unknown, and writes format 1', async () => {
    writeFileSync(versionSidecarPath('ffmpeg'), JSON.stringify({ version: 'autobuild-2026-08-19-19-21' }))
    expect(await readInstalledVersion('ffmpeg')).toBeNull()

    forgetInstalledVersion('ffmpeg')

    await writeVersionSidecar('ffmpeg', 'autobuild-2026-09-01-00-00')
    expect(JSON.parse(readFileSync(versionSidecarPath('ffmpeg'), 'utf8'))).toMatchObject(header('binaryVersion'))
  })

  it('reads a sidecar in a newer format as unknown and leaves it byte-identical', async () => {
    const text = JSON.stringify({ ...header('binaryVersion', 2), version: 'autobuild-2026-08-19-19-21' })
    writeFileSync(versionSidecarPath('ffmpeg'), text)
    expect(await readInstalledVersion('ffmpeg')).toBeNull()
    expect(readFileSync(versionSidecarPath('ffmpeg'), 'utf8')).toBe(text)
  })

  it('is replaced by a reinstall over a sidecar in a newer format', async () => {
    writeFileSync(versionSidecarPath('ffmpeg'), JSON.stringify({ ...header('binaryVersion', 2), version: 'autobuild-2027-01-01-00-00' }))
    await writeVersionSidecar('ffmpeg', 'autobuild-2026-09-01-00-00')
    forgetInstalledVersion('ffmpeg')
    expect(await readInstalledVersion('ffmpeg')).toBe('autobuild-2026-09-01-00-00')
    expect(JSON.parse(readFileSync(versionSidecarPath('ffmpeg'), 'utf8'))).toMatchObject(header('binaryVersion'))
  })

  it('is null when unreadable or empty, rather than a blank version', async () => {
    writeFileSync(versionSidecarPath('ffmpeg'), '{ not json')
    expect(await readInstalledVersion('ffmpeg')).toBeNull()

    forgetInstalledVersion('ffmpeg')
    writeFileSync(versionSidecarPath('ffmpeg'), JSON.stringify({ ...header('binaryVersion'), version: '  ' }))
    expect(await readInstalledVersion('ffmpeg')).toBeNull()
  })
})
