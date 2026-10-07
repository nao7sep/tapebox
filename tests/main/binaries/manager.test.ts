import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Dependencies } from '@shared/dependencies'
import { hostTag } from '@main/paths'

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
  const { createHash } = await import('node:crypto')
  const { hostname } = await import('node:os')
  return {
    paths: { temp: join(testRoot, 'temp'), bin: join(testRoot, 'bin') },
    binaryPath: (name: string) => join(testRoot, 'bin', `${name}.exe`),
    ensureDirs: async () => {
      await mkdir(join(testRoot, 'temp'), { recursive: true })
      await mkdir(join(testRoot, 'bin'), { recursive: true })
    },
    // Mirrors the real @main/paths hostTag exactly, so downloadTempPath's assertion
    // below checks the real staged-name grammar rather than a test-local stand-in.
    hostTag: () => createHash('sha256').update(hostname()).digest('hex').slice(0, 8),
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
      ffmpeg: { name: 'ffmpeg', resolveLatest: vi.fn(), installedVersion: { kind: 'sidecar', parse: () => null } },
      deno: { name: 'deno', resolveLatest: vi.fn(), installedVersion: probe },
    },
  }
})

// The status gather reads the installed version from the artifact — a subprocess
// spawn against whatever happens to sit in the real ~/.tapebox/bin. Stubbed so this
// test stays about the fact fold and never touches the developer's own install.
vi.mock('@main/binaries/installed-version', () => ({
  admitVersionSidecar: vi.fn(async () => undefined),
  readInstalledVersion: vi.fn(async () => null),
  forgetInstalledVersion: vi.fn(),
  writeVersionSidecar: vi.fn(async () => undefined),
}))

import {
  cancelInstall,
  checkForUpdates,
  downloadTempPath,
  installOrUpdate,
  shutdownInstalls,
  resumeInstalls,
} from '@main/binaries/manager'
import { binaryNames, binarySpecs } from '@main/binaries/registry'
import { mutateDependencies } from '@main/store/dependencies'
import { freshBinaryEntry } from '@shared/dependencies'
import { UnsafeUrlError } from '@main/io/network'
import { admitVersionSidecar, forgetInstalledVersion, writeVersionSidecar } from '@main/binaries/installed-version'
import { log } from '@main/io/logger'

afterEach(async () => {
  vi.useRealTimers()
  downloadWithProgress.mockReset()
  verifyBinaryIntegrity.mockReset()
  execCapture.mockReset()
  assertArm64Slice.mockReset()
  extractFileFromZip.mockReset()
  vi.mocked(admitVersionSidecar).mockReset().mockResolvedValue(undefined)
  vi.mocked(writeVersionSidecar).mockReset().mockResolvedValue(undefined)
  vi.restoreAllMocks()
  await rm(testRoot, { recursive: true, force: true })
})

function seed(): void {
  depsRef.current = {
    'yt-dlp': freshBinaryEntry(),
    ffmpeg: freshBinaryEntry(),
    deno: freshBinaryEntry(),
    lastCheckAttemptAtUtc: null,
  }
}

const resolved = (version: string) =>
  ({
    version,
    downloadUrl: 'https://x',
    archive: null,
    maxDownloadBytes: 64 * 1024 * 1024,
    maxInstalledBytes: 64 * 1024 * 1024,
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
    expect(result).toMatchObject({
      outcome: 'completed',
      failures: [{
        name: 'ffmpeg',
        message: { key: 'tools.checkFailed', values: { tool: 'ffmpeg' } },
      }],
    })
    if (result.outcome === 'completed') expect(result.statuses).toHaveLength(3)
  })

  it('cancels the whole check without persisting partial results', async () => {
    seed()
    const controller = new AbortController()
    vi.mocked(binarySpecs['yt-dlp'].resolveLatest).mockImplementation((signal) => rejectWhenAborted(signal!))
    vi.mocked(binarySpecs.ffmpeg.resolveLatest).mockImplementation((signal) => rejectWhenAborted(signal!))
    vi.mocked(binarySpecs.deno.resolveLatest).mockImplementation((signal) => rejectWhenAborted(signal!))

    const check = checkForUpdates(controller.signal)
    controller.abort(new DOMException('cancel check', 'AbortError'))

    await expect(check).rejects.toMatchObject({ name: 'AbortError' })
    expect(binaryNames.every((name) => depsRef.current[name].lastCheckedAtUtc === null)).toBe(true)
  })
})

describe('checkForUpdates — the app-wide attempt time', () => {
  it('is written before anything is resolved, also when every resolve fails', async () => {
    seed()
    const attemptsSeen: (string | null)[] = []
    for (const name of binaryNames) {
      vi.mocked(binarySpecs[name].resolveLatest).mockImplementation(async () => {
        attemptsSeen.push(depsRef.current.lastCheckAttemptAtUtc)
        throw new Error('offline')
      })
    }
    await checkForUpdates()
    expect(depsRef.current.lastCheckAttemptAtUtc).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)
    expect(attemptsSeen).toEqual(binaryNames.map(() => depsRef.current.lastCheckAttemptAtUtc))
    expect(binaryNames.every((name) => depsRef.current[name].lastCheckedAtUtc === null)).toBe(true)
  })
})

describe('downloadTempPath', () => {
  it('is <name>-<hostTag>-<pid>-<nanoid>.partial under temp/, so a crash-left file\'s ' +
    'ownership can be proven before it is swept', () => {
    const p = downloadTempPath('yt-dlp')
    expect(p).toMatch(
      new RegExp(`[/\\\\]temp[/\\\\]yt-dlp-${hostTag()}-${process.pid}-[A-Za-z0-9_-]{10}\\.partial$`),
    )
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

    await expect(installOrUpdate('yt-dlp', 'op-download-failure')).resolves.toMatchObject({
      outcome: 'failed',
      operationId: 'op-download-failure',
      error: { key: 'tools.installFailed', values: { tool: 'yt-dlp' } },
      status: { name: 'yt-dlp', present: false },
    })
    expect(await readdir(join(testRoot, 'temp'))).toEqual([])
  })

  it('keeps a request TimeoutError as a real failure, not a cancellation outcome', async () => {
    seed()
    vi.mocked(binarySpecs['yt-dlp'].resolveLatest).mockRejectedValue(
      new DOMException('The operation was aborted due to timeout', 'TimeoutError'),
    )

    await expect(installOrUpdate('yt-dlp', 'op-timeout')).resolves.toMatchObject({
      outcome: 'failed',
      operationId: 'op-timeout',
      error: { key: 'tools.installFailed', values: { tool: 'yt-dlp' } },
    })
  })

})

describe('install terminal facts', () => {
  it('returns installed truth when upstream fact persistence fails after publication', async () => {
    seed()
    vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin')
    vi.mocked(binarySpecs['yt-dlp'].resolveLatest).mockResolvedValue(resolved('2026.08.21'))
    downloadWithProgress.mockImplementation(async ({ destPath }: { destPath: string }) => {
      await writeFile(destPath, 'verified binary bytes')
    })
    verifyBinaryIntegrity.mockResolvedValue({ verified: true, method: 'sha256' })
    execCapture.mockResolvedValue({ stdout: '', stderr: '', exitCode: 0 })
    assertArm64Slice.mockResolvedValue(undefined)
    vi.mocked(mutateDependencies).mockRejectedValueOnce(new Error('facts save failed'))

    await expect(installOrUpdate('yt-dlp', 'op-post-publish-failure')).resolves.toMatchObject({
      outcome: 'installed',
      operationId: 'op-post-publish-failure',
      status: { name: 'yt-dlp', present: true, installedVersion: null },
    })
    expect(await readdir(join(testRoot, 'bin'))).toEqual(['yt-dlp.exe'])
    expect(log.warn).toHaveBeenCalledWith('installed binary upstream facts could not be recorded', expect.objectContaining({ error: expect.objectContaining({ message: 'facts save failed', stack: expect.stringContaining('facts save failed') }) }))
  })

  it.each([1, 2])('preserves the existing binary when sidecar admission %i refuses', async (admission) => {
    seed()
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32')
    await mkdir(join(testRoot, 'bin'), { recursive: true })
    await writeFile(join(testRoot, 'bin', 'ffmpeg.exe'), 'previous binary')
    vi.mocked(binarySpecs.ffmpeg.resolveLatest).mockResolvedValue(resolved('autobuild-2026-08-19-19-21'))
    downloadWithProgress.mockImplementation(async ({ destPath }: { destPath: string }) => {
      await writeFile(destPath, 'verified binary bytes')
    })
    verifyBinaryIntegrity.mockResolvedValue({ verified: true, method: 'sha256' })
    if (admission === 2) vi.mocked(admitVersionSidecar).mockResolvedValueOnce(undefined)
    vi.mocked(admitVersionSidecar).mockRejectedValueOnce(new Error('newer sidecar was retained'))
    await expect(installOrUpdate('ffmpeg', `op-admission-${admission}`)).resolves.toMatchObject({ outcome: 'failed' })
    expect(await readFile(join(testRoot, 'bin', 'ffmpeg.exe'), 'utf8')).toBe('previous binary')
    expect(await readdir(join(testRoot, 'bin'))).toEqual(['ffmpeg.exe'])
  })

  it('keeps a committed install successful when its sidecar cannot be saved', async () => {
    seed()
    vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin')
    vi.mocked(binarySpecs.ffmpeg.resolveLatest).mockResolvedValue(resolved('autobuild-2026-08-19-19-21'))
    downloadWithProgress.mockImplementation(async ({ destPath }: { destPath: string }) => {
      await writeFile(destPath, 'verified binary bytes')
    })
    verifyBinaryIntegrity.mockResolvedValue({ verified: true, method: 'sha256' })
    execCapture.mockResolvedValue({ stdout: '', stderr: '', exitCode: 0 })
    assertArm64Slice.mockResolvedValue(undefined)
    vi.mocked(writeVersionSidecar).mockRejectedValueOnce(new Error('sidecar save failed'))
    await expect(installOrUpdate('ffmpeg', 'op-sidecar-failure')).resolves.toMatchObject({ outcome: 'installed', status: { present: true, installedVersion: null } })
    expect(await readFile(join(testRoot, 'bin', 'ffmpeg.exe'), 'utf8')).toBe('verified binary bytes')
    expect(forgetInstalledVersion).toHaveBeenCalledWith('ffmpeg')
    expect(log.warn).toHaveBeenCalledWith('installed binary version could not be recorded', expect.objectContaining({ error: expect.objectContaining({ message: 'sidecar save failed', stack: expect.stringContaining('sidecar save failed') }) }))
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

  async function expectNoPublishedArtifact(
    install: ReturnType<typeof installOrUpdate>,
    operationId: string,
  ): Promise<void> {
    await expect(install).resolves.toMatchObject({ outcome: 'cancelled', operationId })
    expect(await readdir(join(testRoot, 'bin'))).toEqual([])
    expect(await readdir(join(testRoot, 'temp'))).toEqual([])
  }

  it('aborts bounded xattr work and removes the stage instead of publishing it', async () => {
    arrangeInstall()
    execCapture.mockImplementation(
      (_command: string, _args: readonly string[], opts: { signal: AbortSignal }) =>
        rejectWhenAborted(opts.signal),
    )

    const operationId = 'op-xattr'
    const install = installOrUpdate('yt-dlp', operationId)
    await vi.waitFor(() => expect(execCapture).toHaveBeenCalledOnce())
    expect(execCapture).toHaveBeenCalledWith(
      'xattr',
      expect.any(Array),
      expect.objectContaining({ signal: expect.any(AbortSignal), idleTimeoutMs: 5_000 }),
    )

    cancelInstall('yt-dlp', operationId)
    await expectNoPublishedArtifact(install, operationId)
    expect(assertArm64Slice).not.toHaveBeenCalled()
  })

  it('aborts lipo inspection and removes the stage instead of publishing it', async () => {
    arrangeInstall()
    execCapture.mockResolvedValue({ stdout: '', stderr: '', exitCode: 0 })
    assertArm64Slice.mockImplementation((_filePath: string, signal: AbortSignal) =>
      rejectWhenAborted(signal),
    )

    const operationId = 'op-arch'
    const install = installOrUpdate('yt-dlp', operationId)
    await vi.waitFor(() => expect(assertArm64Slice).toHaveBeenCalledOnce())
    expect(assertArm64Slice).toHaveBeenCalledWith(expect.any(String), expect.any(AbortSignal))

    cancelInstall('yt-dlp', operationId)
    await expectNoPublishedArtifact(install, operationId)
  })

  it('passes cancellation into zip extraction and removes both partial and stage', async () => {
    arrangeInstall()
    vi.mocked(binarySpecs['yt-dlp'].resolveLatest).mockResolvedValue({
      version: '2026.08.21',
      downloadUrl: 'https://x',
      archive: { kind: 'zip', innerName: 'yt-dlp' },
      maxDownloadBytes: 64 * 1024 * 1024,
      maxInstalledBytes: 64 * 1024 * 1024,
      integrity: { kind: 'sums', url: 'https://x/sums', assetName: 'x' },
    } as never)
    extractFileFromZip.mockImplementation(
      (_zip: string, _inner: string, _stage: string, _maxBytes: number, signal: AbortSignal) =>
        rejectWhenAborted(signal),
    )

    const operationId = 'op-zip'
    const install = installOrUpdate('yt-dlp', operationId)
    await vi.waitFor(() => expect(extractFileFromZip).toHaveBeenCalledOnce())
    expect(extractFileFromZip).toHaveBeenCalledWith(
      expect.any(String),
      'yt-dlp',
      expect.any(String),
      64 * 1024 * 1024,
      expect.any(AbortSignal),
    )

    expect(cancelInstall('yt-dlp', 'older-op')).toEqual({ outcome: 'not-running' })
    expect(cancelInstall('yt-dlp', operationId)).toEqual({ outcome: 'cancel-requested' })
    await expectNoPublishedArtifact(install, operationId)
  })

  it('cancels and joins active acquisition cleanup during application shutdown', async () => {
    arrangeInstall()
    execCapture.mockImplementation(
      (_command: string, _args: readonly string[], opts: { signal: AbortSignal }) =>
        rejectWhenAborted(opts.signal),
    )
    const operationId = 'op-shutdown'
    const install = installOrUpdate('yt-dlp', operationId)
    await vi.waitFor(() => expect(execCapture).toHaveBeenCalledOnce())

    await shutdownInstalls()
    await expectNoPublishedArtifact(install, operationId)
    expect(cancelInstall('yt-dlp', operationId)).toEqual({ outcome: 'not-running' })
  })
  it('reopens a cancelled quit while retaining the still-settling install claim', async () => {
    resumeInstalls()
    arrangeInstall()
    let release!: () => void
    const released = new Promise<void>((resolve) => { release = resolve })
    execCapture.mockImplementation(async (_command: string, _args: readonly string[], opts: { signal: AbortSignal }) => {
      await new Promise<void>((resolve) => opts.signal.addEventListener('abort', () => resolve(), { once: true }))
      await released
      opts.signal.throwIfAborted()
    })
    const install = installOrUpdate('yt-dlp', 'held-shutdown')
    let closing: Promise<void> | undefined
    try {
      await vi.waitFor(() => expect(execCapture).toHaveBeenCalledOnce())
      closing = shutdownInstalls()
      resumeInstalls()
      await expect(installOrUpdate('yt-dlp', 'too-early')).resolves.toMatchObject({ outcome: 'failed', error: { key: 'tools.installBusy' } })
      release()
      await closing
      await expectNoPublishedArtifact(install, 'held-shutdown')
      vi.mocked(binarySpecs['yt-dlp'].resolveLatest).mockRejectedValue(new Error('upstream unavailable'))
      await expect(installOrUpdate('yt-dlp', 'fresh-after-resume')).resolves.toMatchObject({ outcome: 'failed', operationId: 'fresh-after-resume' })
    } finally {
      release()
      await closing
      await install
    }
  })

})
