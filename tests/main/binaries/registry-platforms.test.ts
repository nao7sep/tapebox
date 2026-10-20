import { afterEach, describe, expect, it, vi } from 'vitest'

// Which managed-tool build each platform fetches, and how its installed version is
// read, with the platform and architecture supplied: every branch runs on any host.
// No network; the release listings are fixtures.

const fetchLatestRelease = vi.fn()
const fetchReleases = vi.fn()
const fetchRedirectLocation = vi.fn()
vi.mock('@main/binaries/github', () => ({
  fetchLatestRelease: (...args: unknown[]) => fetchLatestRelease(...args),
  fetchReleases: (...args: unknown[]) => fetchReleases(...args),
}))
vi.mock('@main/io/fetch-json', () => ({
  fetchRedirectLocation: (...args: unknown[]) => fetchRedirectLocation(...args),
}))

const asset = (name: string) => ({ name, browser_download_url: `https://example.test/${name}`, size: 1 })

const YTDLP_ASSETS = ['yt-dlp_macos', 'yt-dlp.exe', 'yt-dlp_linux', 'yt-dlp', 'SHA2-256SUMS']
const DENO_ASSETS = [
  'deno-aarch64-apple-darwin.zip', 'deno-x86_64-apple-darwin.zip', 'deno-x86_64-pc-windows-msvc.zip',
  'deno-x86_64-unknown-linux-gnu.zip', 'deno-aarch64-unknown-linux-gnu.zip',
].flatMap((name) => [name, `${name}.sha256sum`])

/** The registry as loaded on `platform`/`arch`: ffmpeg's version source is chosen at load. */
async function registryOn(platform: NodeJS.Platform, arch: NodeJS.Architecture) {
  vi.spyOn(process, 'platform', 'get').mockReturnValue(platform)
  vi.spyOn(process, 'arch', 'get').mockReturnValue(arch)
  vi.resetModules()
  return (await import('@main/binaries/registry')).binarySpecs
}

afterEach(() => {
  vi.restoreAllMocks()
  fetchLatestRelease.mockReset()
  fetchReleases.mockReset()
  fetchRedirectLocation.mockReset()
})

describe('yt-dlp build per platform', () => {
  it.each([
    ['darwin', 'yt-dlp_macos'],
    ['win32', 'yt-dlp.exe'],
    ['linux', 'yt-dlp_linux'],
  ] as const)('%s fetches %s', async (platform, name) => {
    const specs = await registryOn(platform, 'x64')
    fetchLatestRelease.mockResolvedValue({ tag_name: '2026.09.01', assets: YTDLP_ASSETS.map(asset) })
    await expect(specs['yt-dlp'].resolveLatest()).resolves.toMatchObject({
      downloadUrl: `https://example.test/${name}`,
      archive: null,
      integrity: { kind: 'sums', assetName: name },
    })
  })

  it('refuses a platform yt-dlp publishes no build for', async () => {
    const specs = await registryOn('freebsd', 'x64')
    fetchLatestRelease.mockResolvedValue({ tag_name: '2026.09.01', assets: YTDLP_ASSETS.map(asset) })
    await expect(specs['yt-dlp'].resolveLatest()).rejects.toThrow('Unsupported platform for yt-dlp: freebsd')
  })
})

describe('Deno build per platform and architecture', () => {
  it.each([
    ['darwin', 'arm64', 'deno-aarch64-apple-darwin.zip', 'deno'],
    ['win32', 'x64', 'deno-x86_64-pc-windows-msvc.zip', 'deno.exe'],
    ['linux', 'x64', 'deno-x86_64-unknown-linux-gnu.zip', 'deno'],
    ['linux', 'arm64', 'deno-aarch64-unknown-linux-gnu.zip', 'deno'],
  ] as const)('%s %s fetches %s holding %s', async (platform, arch, name, innerName) => {
    const specs = await registryOn(platform, arch)
    fetchLatestRelease.mockResolvedValue({ tag_name: 'v2.9.7', assets: DENO_ASSETS.map(asset) })
    await expect(specs.deno.resolveLatest()).resolves.toMatchObject({
      version: '2.9.7',
      downloadUrl: `https://example.test/${name}`,
      archive: { kind: 'zip', innerName },
      integrity: { kind: 'sums', url: `https://example.test/${name}.sha256sum`, assetName: name },
    })
  })

  it.each([
    ['win32', 'arm64'],
    // macOS is Apple Silicon only, as for ffmpeg, though Deno publishes an Intel build.
    ['darwin', 'x64'],
  ] as const)('refuses %s %s as unsupported', async (platform, arch) => {
    const specs = await registryOn(platform, arch)
    fetchLatestRelease.mockResolvedValue({ tag_name: 'v2.9.7', assets: DENO_ASSETS.map(asset) })
    await expect(specs.deno.resolveLatest()).rejects.toThrow(`Unsupported platform/arch for deno: ${platform}/${arch}`)
  })
})

describe('ffmpeg source and installed version per platform', () => {
  it('macOS follows martin-riedl\'s arm64 release redirect and probes the binary', async () => {
    const specs = await registryOn('darwin', 'arm64')
    expect(specs.ffmpeg.installedVersion.kind).toBe('probe')
    fetchRedirectLocation.mockResolvedValue('/download/macos/arm64/1778761665_8.1.1/ffmpeg.zip')

    await expect(specs.ffmpeg.resolveLatest()).resolves.toMatchObject({
      version: '8.1.1',
      downloadUrl: 'https://ffmpeg.martin-riedl.de/download/macos/arm64/1778761665_8.1.1/ffmpeg.zip',
      archive: { kind: 'zip', innerName: 'ffmpeg' },
      integrity: {
        kind: 'sums',
        url: 'https://ffmpeg.martin-riedl.de/download/macos/arm64/1778761665_8.1.1/ffmpeg.zip.sha256',
        assetName: 'ffmpeg.zip',
      },
    })
    expect(fetchRedirectLocation).toHaveBeenCalledWith(
      'https://ffmpeg.martin-riedl.de/redirect/latest/macos/arm64/release/ffmpeg.zip',
      expect.anything(),
    )
  })

  it('macOS refuses a redirect that downgrades to plain http', async () => {
    const specs = await registryOn('darwin', 'arm64')
    fetchRedirectLocation.mockResolvedValue('http://ffmpeg.martin-riedl.de/download/macos/arm64/1_8.1.1/ffmpeg.zip')
    await expect(specs.ffmpeg.resolveLatest()).rejects.toThrow()
  })

  it('Windows pins BtbN\'s immutable build and reads the version from its sidecar', async () => {
    const specs = await registryOn('win32', 'x64')
    expect(specs.ffmpeg.installedVersion.kind).toBe('sidecar')
    fetchReleases.mockResolvedValue([{
      tag_name: 'autobuild-2026-09-26-13-03',
      assets: [asset('checksums.sha256'), asset('ffmpeg-N-126889-gb139ba11d8-win64-gpl.zip')],
    }])
    await expect(specs.ffmpeg.resolveLatest()).resolves.toMatchObject({
      version: 'autobuild-2026-09-26-13-03',
      archive: { kind: 'zip', innerName: 'ffmpeg.exe' },
    })
    expect(fetchRedirectLocation).not.toHaveBeenCalled()
  })

  it('Linux probes a user-placed ffmpeg and has no managed source', async () => {
    const specs = await registryOn('linux', 'x64')
    expect(specs.ffmpeg.installedVersion.kind).toBe('probe')
    await expect(specs.ffmpeg.resolveLatest()).rejects.toThrow('ffmpeg auto-install not yet supported on linux')
    expect(fetchReleases).not.toHaveBeenCalled()
    expect(fetchRedirectLocation).not.toHaveBeenCalled()
  })
})
