import { execFile } from 'node:child_process'
import { readdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { freshBinaryEntry, type Dependencies } from '@shared/dependencies'

// The install's final preparation on macOS with the real tools: xattr strips the
// quarantine flag and lipo reads the architecture, each on a real file. The other
// manager tests pass the platform in and stub both tools.

const execFileAsync = promisify(execFile)
const testRoot = vi.hoisted(
  () => `${process.env.TEMP ?? process.env.TMPDIR ?? '/tmp'}/tapebox-manager-darwin-${process.pid}`,
)
const fixture = vi.hoisted(() => ({ bytes: Buffer.alloc(0) }))
const log = vi.hoisted(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }))

vi.mock('@main/paths', async () => {
  const { join } = await import('node:path')
  const { mkdir } = await import('node:fs/promises')
  return {
    paths: { temp: join(testRoot, 'temp'), bin: join(testRoot, 'bin') },
    binaryPath: (name: string) => join(testRoot, 'bin', name),
    ensureDirs: async () => {
      await mkdir(join(testRoot, 'temp'), { recursive: true })
      await mkdir(join(testRoot, 'bin'), { recursive: true })
    },
    hostTag: () => 'test',
  }
})

// The download lands as a browser download would: carrying the quarantine flag.
vi.mock('@main/binaries/http', async () => {
  const { writeFile } = await import('node:fs/promises')
  const { execFile } = await import('node:child_process')
  const { promisify } = await import('node:util')
  return {
    downloadWithProgress: async ({ destPath }: { destPath: string }) => {
      const run = promisify(execFile)
      await writeFile(destPath, fixture.bytes)
      await run('xattr', ['-w', 'com.apple.quarantine', '0081;00000000;TapeBox;', destPath])
      const { stdout } = await run('xattr', [destPath])
      if (!stdout.split('\n').includes('com.apple.quarantine')) throw new Error('the fixture did not take the quarantine flag')
    },
  }
})
vi.mock('@main/binaries/integrity', () => ({
  verifyBinaryIntegrity: async () => ({ verified: true, method: 'sha256' }),
}))
vi.mock('@main/ipc/events', () => ({ emit: vi.fn() }))
vi.mock('@main/io/logger', () => ({ log }))

const depsRef: { current: Dependencies } = { current: null as unknown as Dependencies }
vi.mock('@main/store/dependencies', () => ({
  getDependencies: () => depsRef.current,
  mutateDependencies: async (mutator: (d: Dependencies) => Partial<Dependencies>) => {
    depsRef.current = { ...depsRef.current, ...mutator(depsRef.current) }
    return depsRef.current
  },
}))
vi.mock('@main/binaries/registry', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@main/binaries/registry')>()
  const resolved = {
    version: '2026.08.21',
    downloadUrl: 'https://x',
    archive: null,
    maxDownloadBytes: 1024,
    maxInstalledBytes: 1024,
    integrity: { kind: 'sums', url: 'https://x/sums', assetName: 'x' },
  }
  const spec = (name: string) => ({
    name,
    resolveLatest: async () => resolved,
    installedVersion: { kind: 'probe', args: ['--version'], parse: () => null },
  })
  return { ...actual, binarySpecs: { 'yt-dlp': spec('yt-dlp'), ffmpeg: spec('ffmpeg'), deno: spec('deno') } }
})
vi.mock('@main/binaries/installed-version', () => ({
  readInstalledVersion: async () => null,
  forgetInstalledVersion: vi.fn(),
  writeVersionSidecar: async () => undefined,
}))

import { installOrUpdate } from '@main/binaries/manager'

/** A Mach-O 64-bit executable header for one CPU, all that `lipo -archs` reads. */
function machOHeader(cpuType: number, cpuSubtype: number): Buffer {
  const header = Buffer.alloc(32)
  header.writeUInt32LE(0xfeedfacf, 0)
  header.writeInt32LE(cpuType, 4)
  header.writeInt32LE(cpuSubtype, 8)
  header.writeUInt32LE(2, 12) // MH_EXECUTE
  return header
}
const ARM64 = machOHeader(0x0100000c, 0)
const X86_64 = machOHeader(0x01000007, 3)

async function attributes(path: string): Promise<string[]> {
  const { stdout } = await execFileAsync('xattr', [path])
  return stdout.split('\n')
}

beforeEach(() => {
  depsRef.current = {
    'yt-dlp': freshBinaryEntry(),
    ffmpeg: freshBinaryEntry(),
    deno: freshBinaryEntry(),
    lastCheckAttemptAtUtc: null,
  }
})
afterEach(async () => {
  vi.clearAllMocks()
  await rm(testRoot, { recursive: true, force: true })
})

describe('install final preparation on macOS', () => {
  it('publishes an arm64 binary with the quarantine flag stripped', async (ctx) => {
    ctx.skip(process.platform !== 'darwin', 'macOS only: the quarantine flag, xattr and lipo exist only there')
    fixture.bytes = ARM64

    await expect(installOrUpdate('yt-dlp', 'op-arm64')).resolves.toMatchObject({ outcome: 'installed' })

    const published = join(testRoot, 'bin', 'yt-dlp')
    expect(await attributes(published)).not.toContain('com.apple.quarantine')
  })

  it('rejects an x86_64-only binary and publishes nothing', async (ctx) => {
    ctx.skip(process.platform !== 'darwin', 'macOS only: lipo and the arm64 gate exist only there')
    fixture.bytes = X86_64

    await expect(installOrUpdate('yt-dlp', 'op-x86')).resolves.toMatchObject({ outcome: 'failed' })

    expect(await readdir(join(testRoot, 'bin'))).toEqual([])
    expect(await readdir(join(testRoot, 'temp'))).toEqual([])
    expect(log.warn).toHaveBeenCalledWith('binary install failed', expect.objectContaining({
      error: expect.objectContaining({ message: expect.stringContaining('not arm64-native (lipo reports: x86_64)') }),
    }))
  })
})
