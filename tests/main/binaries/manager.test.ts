import { readdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Dependencies } from '@shared/dependencies'

const testRoot = vi.hoisted(
  () => `${process.env.TEMP ?? process.env.TMPDIR ?? '/tmp'}/tapebox-manager-${process.pid}`,
)
const downloadWithProgress = vi.hoisted(() => vi.fn())
const verifyBinaryIntegrity = vi.hoisted(() => vi.fn())
const execCapture = vi.hoisted(() => vi.fn())
const assertArm64Slice = vi.hoisted(() => vi.fn())
const extractFileFromZip = vi.hoisted(() => vi.fn())

vi.mock('@main/paths', async () => {
  const { join } = await import('node:path')
  const { mkdir } = await import('node:fs/promises')
  return {
    paths: { temp: join(testRoot, 'temp'), bin: join(testRoot, 'bin') },
    binaryPath: (name: string) => join(testRoot, 'bin', `${name}.exe`),
    ensureDirs: async () => {
      await mkdir(join(testRoot, 'temp'), { recursive: true })
      await mkdir(join(testRoot, 'bin'), { recursive: true })
    },
  }
})

vi.mock('@main/binaries/http', () => ({ downloadWithProgress }))
vi.mock('@main/binaries/integrity', () => ({ verifyBinaryIntegrity }))
vi.mock('@main/io/spawn', () => ({ execCapture }))
vi.mock('@main/binaries/arch', () => ({ assertArm64Slice }))
vi.mock('@main/binaries/archive', () => ({ extractFileFromZip }))
vi.mock('@main/ipc/events', () => ({ emit: vi.fn() }))

// checkForUpdates is the orchestration seam for the convention's honest-state rule:
// a successful resolve records the latest + time; a failed one writes NOTHING. The
// dependencies store and the upstream registry are mocked at their module
// boundaries so the fold is exercised without touching the network or disk.
const depsRef: { current: Dependencies } = { current: null as unknown as Dependencies }

vi.mock('@main/io/logger', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))

vi.mock('@main/store/dependencies', () => ({
  getDependencies: () => depsRef.current,
  mutateDependencies: vi.fn(async (mutator: (d: Dependencies) => Partial<Dependencies>) => {
    depsRef.current = { ...depsRef.current, ...mutator(depsRef.current) }
    return depsRef.current
  }),
}))

vi.mock('@main/binaries/registry', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@main/binaries/registry')>()
  const probe = { kind: 'probe', args: ['--version'], parse: () => null } as const
  return {
    ...actual,
    binarySpecs: {
      'yt-dlp': { name: 'yt-dlp', resolveLatest: vi.fn(), installedVersion: probe },
      ffmpeg: { name: 'ffmpeg', resolveLatest: vi.fn(), installedVersion: probe },
      deno: { name: 'deno', resolveLatest: vi.fn(), installedVersion: probe },
    },
  }
})

// The status gather reads the installed version from the artifact — a subprocess
// spawn against whatever happens to sit in the real ~/.tapebox/bin. Stubbed so this
// test stays about the fact fold and never touches the developer's own install.
vi.mock('@main/binaries/installed-version', () => ({
  readInstalledVersion: vi.fn(async () => null),
  forgetInstalledVersion: vi.fn(),
  writeVersionSidecar: vi.fn(async () => undefined),
}))

import {
  cancelInstall,
  checkForUpdates,
  downloadTempPath,
  installOrUpdate,
} from '@main/binaries/manager'
import { binarySpecs } from '@main/binaries/registry'
import { freshBinaryEntry } from '@shared/dependencies'
import { UnsafeUrlError } from '@main/io/network'

afterEach(async () => {
  downloadWithProgress.mockReset()
  verifyBinaryIntegrity.mockReset()
  execCapture.mockReset()
  assertArm64Slice.mockReset()
  extractFileFromZip.mockReset()
  vi.restoreAllMocks()
  await rm(testRoot, { recursive: true, force: true })
})

function seed(): void {
  depsRef.current = {
    'yt-dlp': freshBinaryEntry(),
    ffmpeg: freshBinaryEntry(),
    deno: freshBinaryEntry(),
  }
}

const resolved = (version: string) =>
  ({
    version,
    downloadUrl: 'https://x',
    archive: null,
    integrity: { kind: 'sums', url: 'https://x/sums', assetName: 'x' },
  }) as never

function rejectWhenAborted(signal: AbortSignal): Promise<never> {
  return new Promise((_, reject) => {
    const onAbort = (): void => reject(signal.reason)
    if (signal.aborted) onAbort()
    else signal.addEventListener('abort', onAbort, { once: true })
  })
}

describe('checkForUpdates — a failed check writes nothing (I3)', () => {
  it('folds only successful resolves; a failed binary keeps its facts null', async () => {
    seed()
    vi.mocked(binarySpecs['yt-dlp'].resolveLatest).mockResolvedValue(resolved('2024.01.01'))
    vi.mocked(binarySpecs.ffmpeg.resolveLatest).mockRejectedValue(new Error('offline'))
    vi.mocked(binarySpecs.deno.resolveLatest).mockResolvedValue(resolved('1.44'))

    const result = await checkForUpdates()

    const b = depsRef.current
    // Successful checks record the latest version and a timestamp.
    expect(b['yt-dlp'].latestKnownVersion).toBe('2024.01.01')
    expect(b['yt-dlp'].lastCheckedAtUtc).not.toBeNull()
    expect(b.deno.latestKnownVersion).toBe('1.44')
    expect(b.deno.lastCheckedAtUtc).not.toBeNull()
    // The failed check wrote nothing — no version, no timestamp.
    expect(b.ffmpeg.latestKnownVersion).toBeNull()
    expect(b.ffmpeg.lastCheckedAtUtc).toBeNull()
    expect(result.failures).toEqual([{ name: 'ffmpeg', message: 'offline' }])
    expect(result.statuses).toHaveLength(3)
  })
})

describe('downloadTempPath', () => {
  it('is <name>-<nanoid>.partial under temp/, per the derived-sibling-name grammar', () => {
    const p = downloadTempPath('yt-dlp')
    expect(p).toMatch(/[/\\]temp[/\\]yt-dlp-[A-Za-z0-9_-]{10}\.partial$/)
  })

  it('discriminates by a random nanoid, not a raw Date.now() epoch', () => {
    // The bug this replaced: Date.now() as the discriminator, which two installs
    // started in the same millisecond would collide on. A nanoid discriminator
    // means back-to-back calls virtually never coincide.
    const first = downloadTempPath('yt-dlp')
    const second = downloadTempPath('yt-dlp')
    expect(first).not.toBe(second)
  })
})

describe('install download cleanup', () => {
  it('removes a partial file when the final download attempt fails', async () => {
    seed()
    vi.mocked(binarySpecs['yt-dlp'].resolveLatest).mockResolvedValue(resolved('2026.08.21'))
    downloadWithProgress.mockImplementation(async ({ destPath }: { destPath: string }) => {
      await writeFile(destPath, 'partial bytes')
      throw new UnsafeUrlError('refusing downgraded response')
    })

    await expect(installOrUpdate('yt-dlp')).rejects.toThrow('refusing downgraded response')
    expect(await readdir(join(testRoot, 'temp'))).toEqual([])
  })

  it('keeps a request TimeoutError as a real failure, not a cancellation outcome', async () => {
    seed()
    vi.mocked(binarySpecs['yt-dlp'].resolveLatest).mockRejectedValue(
      new DOMException('The operation was aborted due to timeout', 'TimeoutError'),
    )

    await expect(installOrUpdate('yt-dlp')).rejects.toMatchObject({ name: 'TimeoutError' })
  })
})

describe('install final-preparation cancellation', () => {
  function arrangeInstall(): void {
    seed()
    vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin')
    vi.mocked(binarySpecs['yt-dlp'].resolveLatest).mockResolvedValue(resolved('2026.08.21'))
    downloadWithProgress.mockImplementation(async ({ destPath }: { destPath: string }) => {
      await writeFile(destPath, 'verified binary bytes')
    })
    verifyBinaryIntegrity.mockResolvedValue({ verified: true, method: 'sha256' })
  }

  async function expectNoPublishedArtifact(install: ReturnType<typeof installOrUpdate>): Promise<void> {
    await expect(install).resolves.toEqual({ outcome: 'cancelled' })
    expect(await readdir(join(testRoot, 'bin'))).toEqual([])
    expect(await readdir(join(testRoot, 'temp'))).toEqual([])
  }

  it('aborts bounded xattr work and removes the stage instead of publishing it', async () => {
    arrangeInstall()
    execCapture.mockImplementation(
      (_command: string, _args: readonly string[], opts: { signal: AbortSignal }) =>
        rejectWhenAborted(opts.signal),
    )

    const install = installOrUpdate('yt-dlp')
    await vi.waitFor(() => expect(execCapture).toHaveBeenCalledOnce(), { timeout: 10_000 })
    expect(execCapture).toHaveBeenCalledWith(
      'xattr',
      expect.any(Array),
      expect.objectContaining({ signal: expect.any(AbortSignal), idleTimeoutMs: 5_000 }),
    )

    cancelInstall('yt-dlp')
    await expectNoPublishedArtifact(install)
    expect(assertArm64Slice).not.toHaveBeenCalled()
  })

  it('aborts lipo inspection and removes the stage instead of publishing it', async () => {
    arrangeInstall()
    execCapture.mockResolvedValue({ stdout: '', stderr: '', exitCode: 0 })
    assertArm64Slice.mockImplementation((_filePath: string, signal: AbortSignal) =>
      rejectWhenAborted(signal),
    )

    const install = installOrUpdate('yt-dlp')
    await vi.waitFor(() => expect(assertArm64Slice).toHaveBeenCalledOnce(), { timeout: 10_000 })
    expect(assertArm64Slice).toHaveBeenCalledWith(expect.any(String), expect.any(AbortSignal))

    cancelInstall('yt-dlp')
    await expectNoPublishedArtifact(install)
  })

  it('passes cancellation into zip extraction and removes both partial and stage', async () => {
    arrangeInstall()
    vi.mocked(binarySpecs['yt-dlp'].resolveLatest).mockResolvedValue({
      version: '2026.08.21',
      downloadUrl: 'https://x',
      archive: { kind: 'zip', innerName: 'yt-dlp' },
      integrity: { kind: 'sums', url: 'https://x/sums', assetName: 'x' },
    } as never)
    extractFileFromZip.mockImplementation(
      (_zip: string, _inner: string, _stage: string, signal: AbortSignal) =>
        rejectWhenAborted(signal),
    )

    const install = installOrUpdate('yt-dlp')
    await vi.waitFor(() => expect(extractFileFromZip).toHaveBeenCalledOnce(), { timeout: 10_000 })
    expect(extractFileFromZip).toHaveBeenCalledWith(
      expect.any(String),
      'yt-dlp',
      expect.any(String),
      expect.any(AbortSignal),
    )

    expect(cancelInstall('yt-dlp')).toEqual({ outcome: 'cancel-requested' })
    await expectNoPublishedArtifact(install)
  })
})
