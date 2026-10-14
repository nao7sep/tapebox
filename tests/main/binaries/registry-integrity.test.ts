import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const fetchLatestRelease = vi.fn()
const fetchReleases = vi.fn()
vi.mock('@main/binaries/github', () => ({
  fetchLatestRelease: (...args: unknown[]) => fetchLatestRelease(...args),
  fetchReleases: (...args: unknown[]) => fetchReleases(...args),
}))

const { binarySpecs } = await import('@main/binaries/registry')

function release(assets: Array<{ name: string; browser_download_url: string; size: number }>) {
  return { tag_name: 'v1.2.3', name: 'Build 1.2.3', assets }
}

function autobuildRelease(assets: Array<{ name: string; browser_download_url: string; size: number }>) {
  return { tag_name: 'autobuild-2026-08-19-19-21', name: 'Auto-Build 2026-08-19 19:21', assets }
}

const asset = (name: string) => ({
  name,
  browser_download_url: `https://example.test/${name}`,
  size: 1,
})

// Asset selection reads the platform at resolve time, so each case supplies one;
// registry-platforms.test.ts covers the selection itself.
function onPlatform(platform: NodeJS.Platform, arch: NodeJS.Architecture): void {
  vi.spyOn(process, 'platform', 'get').mockReturnValue(platform)
  vi.spyOn(process, 'arch', 'get').mockReturnValue(arch)
}

describe('registry integrity is mandatory', () => {
  beforeEach(() => {
    fetchLatestRelease.mockReset()
    fetchReleases.mockReset()
  })
  afterEach(() => { vi.restoreAllMocks() })

  it('refuses a yt-dlp release without SHA2-256SUMS', async () => {
    onPlatform('darwin', 'arm64')
    fetchLatestRelease.mockResolvedValue(release([asset('yt-dlp_macos')]))
    await expect(binarySpecs['yt-dlp'].resolveLatest()).rejects.toThrow('no SHA2-256SUMS')
  })

  it('refuses a Deno release without its per-asset checksum', async () => {
    onPlatform('darwin', 'arm64')
    const name = 'deno-aarch64-apple-darwin.zip'
    fetchLatestRelease.mockResolvedValue(release([asset(name)]))
    await expect(binarySpecs.deno.resolveLatest()).rejects.toThrow(`has no ${name}.sha256sum`)
  })

  it('refuses a Windows ffmpeg release without checksums.sha256', async () => {
    onPlatform('win32', 'x64')
    fetchReleases.mockResolvedValue([
      autobuildRelease([asset('ffmpeg-N-119123-gabcdef0123-win64-gpl.zip')]),
    ])
    await expect(binarySpecs.ffmpeg.resolveLatest()).rejects.toThrow('has no checksums.sha256')
  })
})
